/// <reference types="pouchdb-core" />

declare module "pouchdb-adapters-rn" {
    const pouchdbPlugin: PouchDB.Static;
    export default pouchdbPlugin;
}

declare var PouchDB: PouchDB.Static;
