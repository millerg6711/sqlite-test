import type { JsonColumn, JsonIndex } from '../../definitions';
import { UtilsSQLite } from '../utilsSQLite';

export class UtilsJson {
  private _uSQLite: UtilsSQLite = new UtilsSQLite();
  /**
   * IsTableExists
   * @param db
   * @param isOpen
   * @param tableName
   */
  public async isTableExists(
    db: any,
    isOpen: boolean,
    tableName: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!isOpen) {
        reject('isTableExists: database not opened');
      }
      let query = 'SELECT name FROM sqlite_master WHERE ';
      query += `type='table' AND name='${tableName}';`;
      db.all(query, [], (err: Error, rows: any[]) => {
        // process the row here
        if (err) {
          reject(`isTableExists: failed: ${err.message}`);
        } else {
          if (rows.length === 0) {
            resolve(false);
          } else {
            resolve(true);
          }
        }
      });
    });
  }
  /**
   * CreateSchema
   * @param mDB
   * @param jsonData
   */
  public async createSchema(mDB: any, jsonData: any): Promise<number> {
    // create the database schema
    let changes = 0;
    try {
      // start a transaction
      await this._uSQLite.beginTransaction(mDB, true);
    } catch (err) {
      return Promise.reject(new Error(`CreateDatabaseSchema: ${err.message}`));
    }

    const stmts = await this.createSchemaStatement(jsonData);
    if (stmts.length > 0) {
      const schemaStmt: string = stmts.join('\n');
      try {
        changes = await this._uSQLite.execute(mDB, schemaStmt);
        if (changes < 0) {
          try {
            await this._uSQLite.rollbackTransaction(mDB, true);
          } catch (err) {
            return Promise.reject(
              new Error('CreateSchema: changes < 0 ' + `${err.message}`),
            );
          }
        }
      } catch (err) {
        const msg = err.message;
        try {
          await this._uSQLite.rollbackTransaction(mDB, true);
          return Promise.reject(new Error(`CreateSchema: ${msg}`));
        } catch (err) {
          return Promise.reject(
            new Error('CreateSchema: changes < 0 ' + `${err.message}: ${msg}`),
          );
        }
      }
    }
    try {
      await this._uSQLite.commitTransaction(mDB, true);
      return Promise.resolve(changes);
    } catch (err) {
      return Promise.reject(
        new Error('CreateSchema: commit ' + `${err.message}`),
      );
    }
  }

  /**
   * CreateSchemaStatement
   * @param jsonData
   */
  public async createSchemaStatement(jsonData: any): Promise<string[]> {
    const statements: string[] = [];
    // Prepare the statement to execute
    try {
      for (const jTable of jsonData.tables) {
        if (jTable.schema != null && jTable.schema.length >= 1) {
          // create table
          statements.push('CREATE TABLE IF NOT EXISTS ' + `${jTable.name} (`);
          for (let j = 0; j < jTable.schema.length; j++) {
            if (j === jTable.schema.length - 1) {
              if (jTable.schema.column) {
                statements.push(
                  `${jTable.schema.column} ${jTable.schema[j].value}`,
                );
              } else if (jTable.schema[j].foreignkey) {
                statements.push(
                  `FOREIGN KEY (${jTable.schema[j].foreignkey}) ${jTable.schema[j].value}`,
                );
              } else if (jTable.schema[j].constraint) {
                statements.push(
                  `CONSTRAINT ${jTable.schema[j].constraint} ${jTable.schema[j].value}`,
                );
              }
            } else {
              if (jTable.schema[j].column) {
                statements.push(
                  `${jTable.schema[j].column} ${jTable.schema[j].value},`,
                );
              } else if (jTable.schema[j].foreignkey) {
                statements.push(
                  `FOREIGN KEY (${jTable.schema[j].foreignkey}) ${jTable.schema[j].value},`,
                );
              } else if (jTable.schema[j].constraint) {
                statements.push(
                  `CONSTRAINT ${jTable.schema[j].constraint} ${jTable.schema[j].value},`,
                );
              }
            }
          }
          statements.push(');');
          // create trigger last_modified associated with the table
          let trig = 'CREATE TRIGGER IF NOT EXISTS ';
          trig += `${jTable.name}`;
          trig += `_trigger_last_modified `;
          trig += `AFTER UPDATE ON ${jTable.name} `;
          trig += 'FOR EACH ROW WHEN NEW.last_modified <= ';
          trig += 'OLD.last_modified BEGIN UPDATE ';
          trig += `${jTable.name} `;
          trig += `SET last_modified = `;
          trig += "(strftime('%s','now')) WHERE id=OLD.id; END;";
          statements.push(trig);
        }
        if (jTable.indexes != null && jTable.indexes.length >= 1) {
          for (const jIndex of jTable.indexes) {
            const tableName = jTable.name;
            let stmt = `CREATE ${
              Object.keys(jIndex).includes('mode') ? jIndex.mode + ' ' : ''
            }INDEX `;
            stmt += `${jIndex.name} ON ${tableName} (${jIndex.value});`;
            statements.push(stmt);
          }
        }
      }
      return Promise.resolve(statements);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * CreateDataTable
   * @param mDB
   * @param table
   * @param mode
   */
  public async createDataTable(
    mDB: any,
    table: any,
    mode: string,
  ): Promise<number> {
    let lastId = -1;
    try {
      // Check if the table exists
      const tableExists = await this.isTableExists(mDB, true, table.name);
      if (!tableExists) {
        return Promise.reject(
          new Error('CreateDataTable: Table ' + `${table.name} does not exist`),
        );
      }

      // Get the column names and types
      const tableNamesTypes: any = await this.getTableColumnNamesTypes(
        mDB,
        table.name,
      );
      const tableColumnTypes: string[] = tableNamesTypes.types;
      const tableColumnNames: string[] = tableNamesTypes.names;
      if (tableColumnTypes.length === 0) {
        return Promise.reject(
          new Error(
            'CreateDataTable: Table ' + `${table.name} info does not exist`,
          ),
        );
      }
      // Loop on Table Values
      for (let j = 0; j < table.values.length; j++) {
        // Check the row number of columns
        if (table.values[j].length != tableColumnTypes.length) {
          return Promise.reject(
            new Error(
              `CreateDataTable: Table ${table.name} ` +
                `values row ${j} not correct length`,
            ),
          );
        }
        // Check the column's type before proceeding
        const isColumnTypes: boolean = await this.checkColumnTypes(
          tableColumnTypes,
          table.values[j],
        );
        if (!isColumnTypes) {
          return Promise.reject(
            new Error(
              `CreateDataTable: Table ${table.name} ` +
                `values row ${j} not correct types`,
            ),
          );
        }
        const retisIdExists: boolean = await this.isIdExists(
          mDB,
          table.name,
          tableColumnNames[0],
          table.values[j][0],
        );
        let stmt: string;
        if (mode === 'full' || (mode === 'partial' && !retisIdExists)) {
          // Insert
          const nameString: string = tableColumnNames.join();
          const questionMarkString = await this.createQuestionMarkString(
            tableColumnNames.length,
          );
          stmt = `INSERT INTO ${table.name} (${nameString}) VALUES (`;
          stmt += `${questionMarkString});`;
        } else {
          // Update
          const setString: string = await this.setNameForUpdate(
            tableColumnNames,
          );
          if (setString.length === 0) {
            return Promise.reject(
              new Error(
                `CreateDataTable: Table ${table.name} ` +
                  `values row ${j} not set to String`,
              ),
            );
          }
          stmt =
            `UPDATE ${table.name} SET ${setString} WHERE ` +
            `${tableColumnNames[0]} = ${table.values[j][0]};`;
        }
        lastId = await this._uSQLite.prepareRun(mDB, stmt, table.values[j]);
        if (lastId < 0) {
          return Promise.reject(new Error('CreateDataTable: lastId < 0'));
        }
      }
      return Promise.resolve(lastId);
    } catch (err) {
      return Promise.reject(new Error(`CreateDataTable: ${err.message}`));
    }
  }

  /**
   * GetTableColumnNamesTypes
   * @param mDB
   * @param tableName
   */
  public async getTableColumnNamesTypes(
    mDB: any,
    tableName: string,
  ): Promise<any> {
    let resQuery: any[] = [];
    const retNames: string[] = [];
    const retTypes: string[] = [];
    const query = `PRAGMA table_info('${tableName}');`;
    try {
      resQuery = await this._uSQLite.queryAll(mDB, query, []);
      if (resQuery.length > 0) {
        for (const query of resQuery) {
          retNames.push(query.name);
          retTypes.push(query.type);
        }
      }
      return Promise.resolve({ names: retNames, types: retTypes });
    } catch (err) {
      return Promise.reject(
        new Error('GetTableColumnNamesTypes: ' + `${err.message}`),
      );
    }
  }

  /**
   * CheckColumnTypes
   * @param tableTypes
   * @param rowValues
   */
  private async checkColumnTypes(
    tableTypes: any[],
    rowValues: any[],
  ): Promise<boolean> {
    const isType = true;
    for (let i = 0; i < rowValues.length; i++) {
      if (rowValues[i].toString().toUpperCase() != 'NULL') {
        try {
          await this.isType(tableTypes[i], rowValues[i]);
        } catch (err) {
          return Promise.reject(new Error('checkColumnTypes: Type not found'));
        }
      }
    }
    return Promise.resolve(isType);
  }

  /**
   * IsType
   * @param type
   * @param value
   */
  private async isType(type: string, value: any): Promise<void> {
    let ret = false;
    if (type === 'NULL' && typeof value === 'object') ret = true;
    if (type === 'TEXT' && typeof value === 'string') ret = true;
    if (type === 'INTEGER' && typeof value === 'number') ret = true;
    if (type === 'REAL' && typeof value === 'number') ret = true;
    if (type === 'BLOB' && typeof value === 'string') ret = true;
    if (ret) {
      return Promise.resolve();
    } else {
      return Promise.reject(new Error('IsType: not a SQL Type'));
    }
  }

  /**
   * IsIdExists
   * @param db
   * @param dbName
   * @param firstColumnName
   * @param key
   */
  private async isIdExists(
    db: any,
    dbName: string,
    firstColumnName: string,
    key: any,
  ): Promise<boolean> {
    let ret = false;
    const query: string =
      `SELECT ${firstColumnName} FROM ` +
      `${dbName} WHERE ${firstColumnName} = ${key};`;
    try {
      const resQuery: any[] = await this._uSQLite.queryAll(db, query, []);
      if (resQuery.length === 1) ret = true;
      return Promise.resolve(ret);
    } catch (err) {
      return Promise.reject(new Error(`IsIdExists: ${err.message}`));
    }
  }

  /**
   * CreateQuestionMarkString
   * @param length
   */
  private createQuestionMarkString(length: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let retString = '';
      for (let i = 0; i < length; i++) {
        retString += '?,';
      }
      if (retString.length > 1) {
        retString = retString.slice(0, -1);
        resolve(retString);
      } else {
        reject(new Error('CreateQuestionMarkString: length = 0'));
      }
    });
  }

  /**
   * SetNameForUpdate
   * @param names
   */
  private async setNameForUpdate(names: string[]): Promise<string> {
    let retString = '';
    for (const name of names) {
      retString += `${name} = ? ,`;
    }
    if (retString.length > 1) {
      retString = retString.slice(0, -1);
      return Promise.resolve(retString);
    } else {
      return Promise.reject(new Error('SetNameForUpdate: length = 0'));
    }
  }

  /**
   * IsJsonSQLite
   * @param obj
   */
  public isJsonSQLite(obj: any): boolean {
    const keyFirstLevel: string[] = [
      'database',
      'version',
      'encrypted',
      'mode',
      'tables',
    ];
    if (
      obj == null ||
      (Object.keys(obj).length === 0 && obj.constructor === Object)
    )
      return false;
    for (const key of Object.keys(obj)) {
      if (keyFirstLevel.indexOf(key) === -1) return false;
      if (key === 'database' && typeof obj[key] != 'string') return false;
      if (key === 'version' && typeof obj[key] != 'number') return false;
      if (key === 'encrypted' && typeof obj[key] != 'boolean') return false;
      if (key === 'mode' && typeof obj[key] != 'string') return false;
      if (key === 'tables' && typeof obj[key] != 'object') return false;
      if (key === 'tables') {
        for (const oKey of obj[key]) {
          const retTable: boolean = this.isTable(oKey);
          if (!retTable) return false;
        }
      }
    }
    return true;
  }

  /**
   * IsTable
   * @param obj
   */
  private isTable(obj: any): boolean {
    const keyTableLevel: string[] = ['name', 'schema', 'indexes', 'values'];
    let nbColumn = 0;
    if (
      obj == null ||
      (Object.keys(obj).length === 0 && obj.constructor === Object)
    )
      return false;
    for (const key of Object.keys(obj)) {
      if (keyTableLevel.indexOf(key) === -1) return false;
      if (key === 'name' && typeof obj[key] != 'string') return false;
      if (key === 'schema' && typeof obj[key] != 'object') return false;
      if (key === 'indexes' && typeof obj[key] != 'object') return false;
      if (key === 'values' && typeof obj[key] != 'object') return false;
      if (key === 'schema') {
        obj['schema'].forEach(
          (element: {
            column?: string;
            value: string;
            foreignkey?: string;
          }) => {
            if (element.column) {
              nbColumn++;
            }
          },
        );
        for (let i = 0; i < nbColumn; i++) {
          const retSchema: boolean = this.isSchema(obj[key][i]);
          if (!retSchema) return false;
        }
      }
      if (key === 'indexes') {
        for (const oKey of obj[key]) {
          const retIndexes: boolean = this.isIndexes(oKey);
          if (!retIndexes) return false;
        }
      }
      if (key === 'values') {
        if (nbColumn > 0) {
          for (const oKey of obj[key]) {
            if (typeof oKey != 'object' || oKey.length != nbColumn)
              return false;
          }
        }
      }
    }

    return true;
  }
  /**
   * IsSchema
   * @param obj
   */
  private isSchema(obj: any): boolean {
    const keySchemaLevel: string[] = [
      'column',
      'value',
      'foreignkey',
      'constraint',
    ];
    if (
      obj == null ||
      (Object.keys(obj).length === 0 && obj.constructor === Object)
    )
      return false;
    for (const key of Object.keys(obj)) {
      if (keySchemaLevel.indexOf(key) === -1) return false;
      if (key === 'column' && typeof obj[key] != 'string') return false;
      if (key === 'value' && typeof obj[key] != 'string') return false;
      if (key === 'foreignkey' && typeof obj[key] != 'string') return false;
      if (key === 'constraint' && typeof obj[key] != 'string') return false;
    }
    return true;
  }
  /**
   * isIndexes
   * @param obj
   */
  private isIndexes(obj: any): boolean {
    const keyIndexesLevel: string[] = ['name', 'value', 'mode'];
    if (
      obj == null ||
      (Object.keys(obj).length === 0 && obj.constructor === Object)
    )
      return false;
    for (const key of Object.keys(obj)) {
      if (keyIndexesLevel.indexOf(key) === -1) return false;
      if (key === 'name' && typeof obj[key] != 'string') return false;
      if (key === 'value' && typeof obj[key] != 'string') return false;
      if (
        key === 'mode' &&
        (typeof obj[key] != 'string' || obj[key] != 'UNIQUE')
      )
        return false;
    }
    return true;
  }

  /**
   * checkSchemaValidity
   * @param schema
   */
  public async checkSchemaValidity(schema: JsonColumn[]): Promise<void> {
    for (let i = 0; i < schema.length; i++) {
      const sch: JsonColumn = {} as JsonColumn;
      const keys: string[] = Object.keys(schema[i]);
      if (keys.includes('column')) {
        sch.column = schema[i].column;
      }
      if (keys.includes('value')) {
        sch.value = schema[i].value;
      }
      if (keys.includes('foreignkey')) {
        sch.foreignkey = schema[i].foreignkey;
      }
      if (keys.includes('constraint')) {
        sch.constraint = schema[i].constraint;
      }
      const isValid: boolean = this.isSchema(sch);
      if (!isValid) {
        return Promise.reject(
          new Error(`CheckSchemaValidity: schema[${i}] not valid`),
        );
      }
    }
    return Promise.resolve();
  }
  /**
   * checkIndexesSchemaValidity
   * @param indexes
   */
  public async checkIndexesValidity(indexes: JsonIndex[]): Promise<void> {
    for (let i = 0; i < indexes.length; i++) {
      const index: JsonIndex = {} as JsonIndex;
      const keys: string[] = Object.keys(indexes[i]);
      if (keys.includes('value')) {
        index.value = indexes[i].value;
      }
      if (keys.includes('name')) {
        index.name = indexes[i].name;
      }
      if (keys.includes('mode')) {
        index.mode = indexes[i].mode;
      }

      const isValid: boolean = this.isIndexes(index);
      if (!isValid) {
        return Promise.reject(
          new Error(`CheckIndexesValidity: indexes[${i}] not valid`),
        );
      }
    }
    return Promise.resolve();
  }
}
