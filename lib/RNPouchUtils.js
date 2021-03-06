/* eslint-disable */
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault(ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var pouchdbUtils = require('pouchdb-utils');
var pouchdbErrors = require('pouchdb-errors');
var pouchdbMerge = require('pouchdb-merge');
var pouchdbBinaryUtils = require('pouchdb-binary-utils');
var pouchdbMd5 = require('pouchdb-md5');
var pouchdbCollections = require('pouchdb-collections');
var RNFetchBlob = require('react-native-fetch-blob').default;
var Platform = require('react-native').Platform;

function allDocsKeysQuery(api, opts) {
  var keys = opts.keys;
  var finalResults = {
    offset: opts.skip
  };
  return Promise.all(keys.map(function (key) {
    var subOpts = pouchdbUtils.assign({ key: key, deleted: 'ok' }, opts);
    ['limit', 'skip', 'keys'].forEach(function (optKey) {
      delete subOpts[optKey];
    });
    return new Promise(function (resolve, reject) {
      api._allDocs(subOpts, function (err, res) {
        /* istanbul ignore if */
        if (err) {
          return reject(err);
        }
        /* istanbul ignore if */
        if (opts.update_seq && res.update_seq !== undefined) {
          finalResults.update_seq = res.update_seq;
        }
        finalResults.total_rows = res.total_rows;
        resolve(res.rows[0] || { key: key, error: 'not_found' });
      });
    });
  })).then(function (results) {
    finalResults.rows = results;
    return finalResults;
  });
}

function toObject(array) {
  return array.reduce(function (obj, item) {
    obj[item] = true;
    return obj;
  }, {});
}

// List of top level reserved words for doc
var reservedWords = toObject([
  '_id',
  '_rev',
  '_attachments',
  '_deleted',
  '_revisions',
  '_revs_info',
  '_conflicts',
  '_deleted_conflicts',
  '_local_seq',
  '_rev_tree',
  //replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats',
  // Specific to Couchbase Sync Gateway
  '_removed'
]);

// List of reserved words that should end up the document
var dataWords = toObject([
  '_attachments',
  //replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats'
]);

function parseRevisionInfo(rev$$1) {
  if (!/^\d+-./.test(rev$$1)) {
    return pouchdbErrors.createError(pouchdbErrors.INVALID_REV);
  }
  var idx = rev$$1.indexOf('-');
  var left = rev$$1.substring(0, idx);
  var right = rev$$1.substring(idx + 1);
  return {
    prefix: parseInt(left, 10),
    id: right
  };
}

function makeRevTreeFromRevisions(revisions, opts) {
  var pos = revisions.start - revisions.ids.length + 1;

  var revisionIds = revisions.ids;
  var ids = [revisionIds[0], opts, []];

  for (var i = 1, len = revisionIds.length; i < len; i++) {
    ids = [revisionIds[i], { status: 'missing' }, [ids]];
  }

  return [{
    pos: pos,
    ids: ids
  }];
}

// Preprocess documents, parse their revisions, assign an id and a
// revision for new writes that are missing them, etc
function parseDoc(doc, newEdits, dbOpts) {
  if (!dbOpts) {
    dbOpts = {
      deterministic_revs: true
    };
  }

  var nRevNum;
  var newRevId;
  var revInfo;
  var opts = { status: 'available' };
  if (doc._deleted) {
    opts.deleted = true;
  }

  if (newEdits) {
    if (!doc._id) {
      doc._id = pouchdbUtils.uuid();
    }
    newRevId = pouchdbUtils.rev(doc, dbOpts.deterministic_revs);
    if (doc._rev) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      doc._rev_tree = [{
        pos: revInfo.prefix,
        ids: [revInfo.id, { status: 'missing' }, [[newRevId, opts, []]]]
      }];
      nRevNum = revInfo.prefix + 1;
    } else {
      doc._rev_tree = [{
        pos: 1,
        ids: [newRevId, opts, []]
      }];
      nRevNum = 1;
    }
  } else {
    if (doc._revisions) {
      doc._rev_tree = makeRevTreeFromRevisions(doc._revisions, opts);
      nRevNum = doc._revisions.start;
      newRevId = doc._revisions.ids[0];
    }
    if (!doc._rev_tree) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      nRevNum = revInfo.prefix;
      newRevId = revInfo.id;
      doc._rev_tree = [{
        pos: nRevNum,
        ids: [newRevId, opts, []]
      }];
    }
  }

  pouchdbUtils.invalidIdError(doc._id);

  doc._rev = nRevNum + '-' + newRevId;

  var result = { metadata: {}, data: {} };
  for (var key in doc) {
    /* istanbul ignore else */
    if (Object.prototype.hasOwnProperty.call(doc, key)) {
      var specialKey = key[0] === '_';
      if (specialKey && !reservedWords[key]) {
        var error = pouchdbErrors.createError(pouchdbErrors.DOC_VALIDATION, key);
        error.message = pouchdbErrors.DOC_VALIDATION.message + ': ' + key;
        throw error;
      } else if (specialKey && !dataWords[key]) {
        result.metadata[key.slice(1)] = doc[key];
      } else {
        result.data[key] = doc[key];
      }
    }
  }
  return result;
}

function getFileName(digest, contentType) {
  digest = digest.replace('md5-', '');
  var name = new Buffer(digest, 'base64').toString('hex');
  var extension = contentType.substring(contentType.lastIndexOf('/') + 1);
  return name.concat('.', extension);
}

function processPlatformFileUri(file) {
  var f = file;
  if (Platform.OS === 'ios') {
    f = f.replace('file://', '');
  } else if (Platform.OS === 'android' && !f.startsWith('file://')) {
    f = 'file://'.concat(f);
  }
  return f;
}

function isFileString(str, callback) {
  if (typeof str === 'string' && str.length < 1000) {
    if (str.startsWith('/')) {
      return RNFetchBlob.fs.exists(str).then(function (exist) {
        callback(exist);
      }, function () {
        callback(false);
      });
    } else if (str.startsWith('file://')) {
      return callback(true);
    } else if (str.startsWith('content://') || str.startsWith('assets-library://')) {
      return callback(true);
    }
  }
  callback(false);
}

function parseBase64(data) {
  try {
    return pouchdbBinaryUtils.atob(data);
  } catch (e) {
    var err = pouchdbErrors.createError(pouchdbErrors.BAD_ARG,
      'Attachment is not a valid base64 string');
    return { error: err };
  }
}

function getBase64AttachmentFromUrl(url, callback) {
  RNFetchBlob.fs.readFile(url, 'base64').then(function (base64) {
    callback(null, base64);
  }, function (err) {
    callback(pouchdbErrors.createError(err, 'Failed to read data'));
  });
}

function deleteFile(filePath) {
  RNFetchBlob.fs.unlink(filePath).catch(function (err) {
    // Todo: Handle when not able to delete files
    // console.warn(`PouchDB: Failed to delete file at ${filePath}`, err);
  });
}

/**
 *
 * @param dir: base directory to save the file in
 * @param data: base64 data or temp file url created in the same directory
 * @param digest: md5 digest
 * @param contentType: mimetype
 * @param callback: js callback
 */
function saveRNAttachment(dir, data, digest, contentType, callback) {
  digest = digest.replace('md5-', '');
  var name = getFileName(digest, contentType);
  var path = dir.concat(name);
  isFileString(data, function (isFile) {
    if (isFile) {
      if (path === data) {
        callback(null, name);
      } else {
        // Todo: data will always be a temp file. Handle this situation properly in future
        RNFetchBlob.fs.exists(path)
          .then(function (exist) {
            if (exist) {
              return Promise.resolve();
            }
            return RNFetchBlob.fs.mv(data, path);
          })
          .catch(function (err) {
            if (err.message && err.message.includes('already exists')) {
              return Promise.resolve();
            }
            return Promise.reject(err);
          })
          .then(function () {
            if (data.includes('tmpFile_')) {
              deleteFile(data);
            }
            callback(null, name);
            return Promise.resolve();
          })
          .catch(function (err) {
            if (data.includes('tmpFile_')) {
              deleteFile(data);
            }
            callback(pouchdbErrors.createError(err));
          });
      }
    } else {
      RNFetchBlob.fs.writeFile(path, data, 'base64').then(function () {
        callback(null, name);
      }, function (err) {
        callback(pouchdbErrors.createError(err, 'Failed to process base64 data'));
      });
    }
  });
}

function updateDoc(revLimit, prev, docInfo, results, i, cb, writeDoc, newEdits) {
  if (pouchdbMerge.revExists(prev.rev_tree, docInfo.metadata.rev) && !newEdits) {
    results[i] = docInfo;
    return cb();
  }

  // sometimes this is pre-calculated. historically not always
  var previousWinningRev = prev.winningRev || pouchdbMerge.winningRev(prev);
  var previouslyDeleted = 'deleted' in prev ? prev.deleted :
    pouchdbMerge.isDeleted(prev, previousWinningRev);
  var deleted = 'deleted' in docInfo.metadata ? docInfo.metadata.deleted :
    pouchdbMerge.isDeleted(docInfo.metadata);
  var isRoot = /^1-/.test(docInfo.metadata.rev);

  if (previouslyDeleted && !deleted && newEdits && isRoot) {
    var newDoc = docInfo.data;
    newDoc._rev = previousWinningRev;
    newDoc._id = docInfo.metadata.id;
    docInfo = parseDoc(newDoc, newEdits);
  }

  var merged = pouchdbMerge.merge(prev.rev_tree, docInfo.metadata.rev_tree[0], revLimit);

  var inConflict = newEdits && ((
    (previouslyDeleted && deleted && merged.conflicts !== 'new_leaf') ||
    (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
    (previouslyDeleted && !deleted && merged.conflicts === 'new_branch')));

  if (inConflict) {
    var err = pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);
    results[i] = err;
    return cb();
  }

  var newRev = docInfo.metadata.rev;
  docInfo.metadata.rev_tree = merged.tree;
  docInfo.stemmedRevs = merged.stemmedRevs || [];
  /* istanbul ignore else */
  if (prev.rev_map) {
    docInfo.metadata.rev_map = prev.rev_map; // used only by leveldb
  }

  // recalculate
  var winningRev$$1 = pouchdbMerge.winningRev(docInfo.metadata);
  var winningRevIsDeleted = pouchdbMerge.isDeleted(docInfo.metadata, winningRev$$1);

  // calculate the total number of documents that were added/removed,
  // from the perspective of total_rows/doc_count
  var delta = (previouslyDeleted === winningRevIsDeleted) ? 0 :
    previouslyDeleted < winningRevIsDeleted ? -1 : 1;

  var newRevIsDeleted;
  if (newRev === winningRev$$1) {
    // if the new rev is the same as the winning rev, we can reuse that value
    newRevIsDeleted = winningRevIsDeleted;
  } else {
    // if they're not the same, then we need to recalculate
    newRevIsDeleted = pouchdbMerge.isDeleted(docInfo.metadata, newRev);
  }

  writeDoc(docInfo, winningRev$$1, winningRevIsDeleted, newRevIsDeleted,
    true, delta, i, cb);
}

function rootIsMissing(docInfo) {
  return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
}

function processDocs(revLimit, docInfos, api, fetchedDocs, tx, results,
                     writeDoc, opts, overallCallback) {

  // Default to 1000 locally
  revLimit = revLimit || 1000;

  function insertDoc(docInfo, resultsIdx, callback) {
    // Cant insert new deleted documents
    var winningRev$$1 = pouchdbMerge.winningRev(docInfo.metadata);
    var deleted = pouchdbMerge.isDeleted(docInfo.metadata, winningRev$$1);
    if ('was_delete' in opts && deleted) {
      results[resultsIdx] = pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, 'deleted');
      return callback();
    }

    // 4712 - detect whether a new document was inserted with a _rev
    var inConflict = newEdits && rootIsMissing(docInfo);

    if (inConflict) {
      var err = pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);
      results[resultsIdx] = err;
      return callback();
    }

    var delta = deleted ? 0 : 1;

    writeDoc(docInfo, winningRev$$1, deleted, deleted, false,
      delta, resultsIdx, callback);
  }

  var newEdits = opts.new_edits;
  var idsToDocs = new pouchdbCollections.Map();

  var docsDone = 0;
  var docsToDo = docInfos.length;

  function checkAllDocsDone() {
    if (++docsDone === docsToDo && overallCallback) {
      overallCallback();
    }
  }

  docInfos.forEach(function (currentDoc, resultsIdx) {

    if (currentDoc._id && pouchdbMerge.isLocalId(currentDoc._id)) {
      var fun = currentDoc._deleted ? '_removeLocal' : '_putLocal';
      api[fun](currentDoc, { ctx: tx }, function (err, res) {
        results[resultsIdx] = err || res;
        checkAllDocsDone();
      });
      return;
    }

    var id = currentDoc.metadata.id;
    if (idsToDocs.has(id)) {
      docsToDo--; // duplicate
      idsToDocs.get(id).push([currentDoc, resultsIdx]);
    } else {
      idsToDocs.set(id, [[currentDoc, resultsIdx]]);
    }
  });

  // in the case of new_edits, the user can provide multiple docs
  // with the same id. these need to be processed sequentially
  idsToDocs.forEach(function (docs, id) {
    var numDone = 0;

    function docWritten() {
      if (++numDone < docs.length) {
        nextDoc();
      } else {
        checkAllDocsDone();
      }
    }

    function nextDoc() {
      var value = docs[numDone];
      var currentDoc = value[0];
      var resultsIdx = value[1];

      if (fetchedDocs.has(id)) {
        updateDoc(revLimit, fetchedDocs.get(id), currentDoc, results,
          resultsIdx, docWritten, writeDoc, newEdits);
      } else {
        // Ensure stemming applies to new writes as well
        var merged = pouchdbMerge.merge([], currentDoc.metadata.rev_tree[0], revLimit);
        currentDoc.metadata.rev_tree = merged.tree;
        currentDoc.stemmedRevs = merged.stemmedRevs || [];
        insertDoc(currentDoc, resultsIdx, docWritten);
      }
    }

    nextDoc();
  });
}

function cleanDirectory(dir) {
  RNFetchBlob.fs.lstat(dir).then(function (stats) {
    const promises = [];
    if (stats && Array.isArray(stats)) {
      stats.forEach((file) => {
        if (file && file.type === 'file' && file.filename && file.filename.startsWith('tmpFile_')) {
          if (file.path.endsWith(file.filename)) {
            const filePath = file.path;
            promises.push(RNFetchBlob.fs.unlink(filePath).catch(() => Promise.resolve()));
          } else {
            const filePath = file.path.concat('/', file.filename);
            promises.push(RNFetchBlob.fs.unlink(filePath).catch(() => Promise.resolve()));
          }
        }
      });
    }
    return Promise.all(promises);
  }).catch(function (err) {
      console.warn('Failed to clean db directory');
  });
}

function FileManager(name) {
  var manager = this;
  manager._name = name;
  manager.dbFilePath = null;

  function getDBDir() {
    if (!manager.dbFilePath) {
      var name = manager._name.replace(/[^A-Za-z0-9_-]/g, '').concat('_file');
      if (Platform.OS === 'android') {
        manager.dbFilePath = RNFetchBlob.fs.dirs.DocumentDir.concat(`/${name}/`);
      } else if (Platform.OS === 'ios') {
        var dbDir = RNFetchBlob.fs.dirs.DocumentDir;
        dbDir = dbDir.substring(0, dbDir.lastIndexOf('/'));
        dbDir = dbDir.concat(`/Library/NoCloud/${name}/`);
        manager.dbFilePath = dbDir;
      }
    }
    return manager.dbFilePath;
  };

  manager.getDBFileDir = getDBDir;

  function preprocessString(att, blobType, callback) {
    var d = att.data.split(',');
    if (d.length > 1) {
      att.data = d[1];
    }
    var asBinary = parseBase64(att.data);
    if (asBinary.error) {
      return callback(asBinary.error);
    }

    att.length = asBinary.length;
    pouchdbMd5.binaryMd5(asBinary, function (result) {
      att.digest = 'md5-' + result;
      saveRNAttachment(getDBDir(), att.data, att.digest, att.content_type, function (err, path) {
        if (err) {
          callback(err);
        } else {
          att.data = path;
          callback();
        }
      });
    });
  };

  function preprocessUrl(att, callback) {
    att.data = processPlatformFileUri(att.data);
    var temp = getDBDir().concat('tmpFile_', pouchdbUtils.uuid());
    RNFetchBlob.fs.cp(att.data, temp)
      .then(function () {
        att.data = temp;
        return RNFetchBlob.fs.stat(temp);
      })
      .then(function (stat) {
        att.length = stat.size;
        return RNFetchBlob.fs.hash(temp, 'md5');
      })
      .then(function (md5) {
        var base64 = new Buffer(md5, 'hex').toString('base64');
        att.digest = 'md5-' + base64;
        return saveRNAttachment(getDBDir(), att.data, att.digest, att.content_type, function (err, path) {
          if (err) {
            callback(err);
          } else {
            att.data = path;
            callback();
          }
        });
      })
      .catch(function (err) {
        callback(pouchdbErrors.createError(err, err.message));
      });
  };

  function preprocessAttachment(att, blobType, callback) {
    if (att.stub) {
      return callback();
    } else if (typeof att.data !== 'string') {
      var err = pouchdbErrors.createError(pouchdbErrors.BAD_ARG, 'Attachment should be a base64 string or file uri');
      return callback(err);
    }

    isFileString(att.data, function (isFile) {
      if (isFile) {
        preprocessUrl(att, callback);
      } else { // input is a base64 string
        preprocessString(att, 'base64', callback);
      }
    });
  };

  manager.preprocessAttachments = function (docInfos, blobType, callback) {
    if (!docInfos.length) {
      return callback();
    }

    var docv = 0;
    var overallErr;

    docInfos.forEach(function (docInfo) {
      var attachments = docInfo.data && docInfo.data._attachments ?
        Object.keys(docInfo.data._attachments) : [];
      var recv = 0;

      if (!attachments.length) {
        return done();
      }

      function processedAttachment(err) {
        overallErr = err;
        recv++;
        if (recv === attachments.length) {
          done();
        }
      }

      for (var key in docInfo.data._attachments) {
        if (docInfo.data._attachments.hasOwnProperty(key)) {
          preprocessAttachment(docInfo.data._attachments[key], blobType, processedAttachment);
        }
      }
    });

    function done() {
      docv++;
      if (docInfos.length === docv) {
        if (overallErr) {
          callback(overallErr);
        } else {
          callback();
        }
      }
    }
  };

  manager.parseAttachment = function (data, opts, callback) {
    var f = getDBDir().concat(data);
    f = processPlatformFileUri(f);
    if (opts.path) {
      callback(null, f);
    } else {
      getBase64AttachmentFromUrl(f, callback);
    }
  };

  manager.deleteAttachment = function (fileName) {
    deleteFile(getDBDir().concat(fileName));
  };

  manager.destroy = function (callback) {
    RNFetchBlob.fs.unlink(getDBDir()).then(function () {
      callback(null, true);
    }).catch(callback);
  };

  var dir = getDBDir();
  RNFetchBlob.fs.isDir(dir).then(function (exist) {
    if (!exist) {
      RNFetchBlob.fs.mkdir(dir).catch(function (err) {
        throw err;
      });
    } else {
      cleanDirectory(dir);
    }
  }, function (err) {
    throw err;
  });
}

function hasRNAdapter(db) {
  return db._rn_adapter;
}

function getFilePathForSourceTarget(src, target) {
  if (hasRNAdapter(src) && hasRNAdapter(target)) {
    if (pouchdbUtils.isRemote(src)) {
      if ((pouchdbUtils.isRemote(target))) {
        return false;
      } else {
        return target.getDBFileDir();
      }
    } else {
      return true;
    }
  }
  return false;
}

exports.allDocsKeysQuery = allDocsKeysQuery;
exports.invalidIdError = pouchdbUtils.invalidIdError;
exports.isDeleted = pouchdbMerge.isDeleted;
exports.isLocalId = pouchdbMerge.isLocalId;
exports.normalizeDdocFunctionName = pouchdbUtils.normalizeDdocFunctionName;
exports.parseDdocFunctionName = pouchdbUtils.parseDdocFunctionName;
exports.parseDoc = parseDoc;
exports.updateDoc = updateDoc;
exports.processDocs = processDocs;
exports.isFileString = isFileString;
exports.getFileName = getFileName;
exports.hasRNAdapter = hasRNAdapter;
exports.getFilePathForSourceTarget = getFilePathForSourceTarget;
exports.FileManager = FileManager;
