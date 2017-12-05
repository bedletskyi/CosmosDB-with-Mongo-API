'use strict';

const async = require('async');
const _ = require('lodash');
const MongoClient = require('mongodb').MongoClient;
const fs = require('fs');

const ERROR_CONNECTION = 1;
const ERROR_DB_LIST = 2;
const ERROR_DB_CONNECTION = 3;
const ERROR_LIST_COLLECTION = 4;
const ERROR_GET_DATA = 5;
const ERROR_HANDLE_BUCKET = 6;
const ERROR_COLLECTION_DATA = 7;

module.exports = {
	connect: function(connectionInfo, logger, cb){
		logger.clear();
		logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);
		
		generateConnectionParams(connectionInfo, logger, params => {
			MongoClient.connect(params.url, params.options, function (err, dbConnection) {
				if (err) {
					logger.log('error', [params, err], "Connection error");
					return cb(createError(ERROR_CONNECTION, err));
				} else {
					return cb(null, dbConnection);
				}
			});
		});
	},

	disconnect: function(connectionInfo, logger, cb){
		cb()
	},

	testConnection: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, (err, result) => {
			if (err) {
				cb(true);
			} else {
				cb(false);
				result.close();
			}
		});
	},

	getDatabases: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				return cb(err);
			} else {
				connection.admin().listDatabases((err, dbs) => {
					if(err) {
						logger.log('error', err);
						connection.close();
						return cb(createError(ERROR_DB_LIST, err));
					} else {
						dbs = dbs.databases.map(item => item.name);
						logger.log('info', dbs, 'All databases list', connectionInfo.hiddenKeys);
						connection.close();
						return cb(null, dbs);
					}
				});
			}
		});
	},

	getDocumentKinds: function(connectionInfo, logger, cb) {		
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				console.log(err);
			} else {
				const db = connection.db(connectionInfo.database);
				
				if (!db) {
					connection.close();
					return cb(createError(ERROR_DB_CONNECTION, `Failed connection to database ${connectionInfo.database}`));
				}

				db.listCollections().toArray((err, collections) => {
					if (err) {
						logger.log('error', err);
						connection.close();
						cb(createError(ERROR_LIST_COLLECTION, err));
					} else {
						collections = connectionInfo.includeSystemCollection ? collections : filterSystemCollections(collections);
						logger.log('info', collections, 'Mapped collection list');

						async.map(collections, (collectionData, collItemCallback) => {
							const collection = db.collection(collectionData.name);

							getData(collection, connectionInfo.recordSamplingSettings, function (err, documents) {
								if (err) {
									logger.log('error', err);
									return collItemCallback(err, null);
								} else {
									logger.log('info', { collectionItem: collectionData.name }, 'Getting documents for current collectionItem', connectionInfo.hiddenKeys);
									
									documents  = filterDocuments(documents);
									let inferSchema = generateCustomInferSchema(collectionData.name, documents, { sampleSize: 20 });
									let documentsPackage = getDocumentKindDataFromInfer({ 
										bucketName: collectionData.name,
										inference: inferSchema, 
										isCustomInfer: true, 
										excludeDocKind: connectionInfo.excludeDocKind 
									}, 90);

									return collItemCallback(err, documentsPackage);
								}
							});
						}, (err, items) => {
							if(err){
								logger.log('error', err);
							}

							connection.close();		
							return cb(createError(ERROR_GET_DATA, err), items);
						});
					}
				});
			}			
		});
	},

	getDbCollectionsNames: function(connectionInfo, logger, cb) {
		this.connect(connectionInfo, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				return cb(err)
			} else {
				const db = connection.db(connectionInfo.database);
				
				if (!db) {
					connection.close();
					return cb(createError(ERROR_DB_CONNECTION, `Failed connection to database ${connectionInfo.database}`));
				}

				logger.log('info', { Database: connectionInfo.database }, 'Getting collections list for current database', connectionInfo.hiddenKeys);
				
				db.listCollections().toArray((err, collections) => {
					if(err){
						logger.log('error', err);
						connection.close();
						return cb(createError(ERROR_LIST_COLLECTION, err));
					} else {
						let collectionNames = (connectionInfo.includeSystemCollection ? collections : filterSystemCollections(collections)).map(item => item.name);
						logger.log('info', collectionNames, "Collection list for current database", connectionInfo.hiddenKeys);
						handleBucket(connectionInfo, collectionNames, db, function (err, items) {
							connection.close();
							if (err) {
								cb(err);
							} else {
								cb(null, items);
							}
						});
					}
				});
			}
		});
	},

	getDbCollectionsData: function(data, logger, cb){
		let includeEmptyCollection = data.includeEmptyCollection;
		let { recordSamplingSettings, fieldInference } = data;
		logger.log('info', getSamplingInfo(recordSamplingSettings, fieldInference), 'Reverse-Engineering sampling params', data.hiddenKeys);

		let bucketList = data.collectionData.dataBaseNames;

		logger.log('info', { CollectionList: bucketList }, 'Selected collection list', data.hiddenKeys);

		this.connect(data, logger, (err, connection) => {
			if (err) {
				logger.log('error', err);
				return cb(err);
			} else {
				const db = connection.db(data.database);

				if (!db) {
					connection.close();
					let error = `Failed connection to database ${data.database}`;
					logger.log('error', error);
					return cb(createError(ERROR_DB_CONNECTION, error));
				}

				let modelInfo = {
					dbId: data.database,
					accountID: data.password,
					version: []
				};

				db.admin().buildInfo((err, version) => {
					if (err) {
						modelInfo.version = info.versionArray;
					}
				});

				async.map(bucketList, (bucketName, collItemCallback) => {
					const collection = db.collection(bucketName);
					const bucketInfo = {};
					
					collection.indexes(function(err, collecctionIndexes){
						if (err){
							logger.log('error', err);
							return collectionItemCallback(err, null);
						} else {
							const indexes = collecctionIndexes.filter(index => {
								delete index.ns;
								delete index.v;
								return  index.name;
							});

							getData(collection, recordSamplingSettings, (err, documents) => {
								if(err) {
									logger.log('error', err);
									return collItemCallback(err, null);
								} else {
									documents  = filterDocuments(documents);
									let documentKindName = data.documentKinds[bucketName].documentKindName || '*';
									let docKindsList = data.collectionData.collections[bucketName];
									let collectionPackages = [];										

									if (documentKindName !== '*') {
										if(!docKindsList) {
											if (includeEmptyCollection) {
												let documentsPackage = {
													dbName: bucketName,
													emptyBucket: true,
													indexes: [],
													bucketIndexes: indexes,
													views: [],
													validation: false,
													bucketInfo
												};

												collectionPackages.push(documentsPackage)
											}
										} else {
											docKindsList.forEach(docKindItem => {
												let newArrayDocuments = documents.filter((item) => {
													return item[documentKindName] == docKindItem;
												});

												let documentsPackage = {
													dbName: bucketName,
													collectionName: docKindItem,
													documents: newArrayDocuments || [],
													indexes: [],
													bucketIndexes: indexes,
													views: [],
													validation: false,
													docType: documentKindName,
													bucketInfo
												};

												if(fieldInference.active === 'field') {
													documentsPackage.documentTemplate = newArrayDocuments[0] || null;
												}
												if (documentsPackage.documents.length > 0 || includeEmptyCollection) {
													collectionPackages.push(documentsPackage)
												}
											});
										}
									} else {
										let documentsPackage = {
											dbName: bucketName,
											collectionName: bucketName,
											documents: documents || [],
											indexes: [],
											bucketIndexes: indexes,
											views: [],
											validation: false,
											docType: bucketName,
											bucketInfo
										};

										if(fieldInference.active === 'field'){
											documentsPackage.documentTemplate = documents[0] || null;
										}
										if (documentsPackage.documents.length > 0 || includeEmptyCollection) {
											collectionPackages.push(documentsPackage);
										}
									}

									return collItemCallback(err, collectionPackages);
								}
							});
						}
					});
				}, (err, items) => {
					if(err){
						logger.log('error', err);
					}
					connection.close();
					return cb(createError(ERROR_COLLECTION_DATA, err), items, modelInfo);
				});
			}
		});
	}
};

function getSamplingInfo(recordSamplingSettings, fieldInference){
	let samplingInfo = {};
	let value = recordSamplingSettings[recordSamplingSettings.active].value;
	let unit = (recordSamplingSettings.active === 'relative') ? '%' : ' records max';
	samplingInfo.recordSampling = `${recordSamplingSettings.active} ${value}${unit}`
	samplingInfo.fieldInference = (fieldInference.active === 'field') ? 'keep field order' : 'alphabetical order';
	return samplingInfo;
}

function handleBucket(connectionInfo, collectionNames, database, dbItemCallback){
	async.map(collectionNames, (collectionName, collItemCallback) => {
		const collection = database.collection(collectionName);
		if (!collection) {
			return collItemCallback(`Failed got collection ${collectionName}`);
		}

		getData(collection, connectionInfo.recordSamplingSettings, (err, documents) => {
			if(err){
				return collItemCallback(err);
			} else {
				documents  = filterDocuments(documents);
				let documentKind = connectionInfo.documentKinds[collectionName].documentKindName || '*';
				let documentTypes = [];

				if (documentKind !== '*') {
					documentTypes = documents.map(function(doc){
						return doc[documentKind];
					});
					documentTypes = documentTypes.filter((item) => Boolean(item));
					documentTypes = _.uniq(documentTypes);
				}

				let dataItem = prepareConnectionDataItem(documentTypes, collectionName, database, documents.length === 0);
				return collItemCallback(err, dataItem);
			}
		});
	}, (err, items) => {
		return dbItemCallback(createError(ERROR_HANDLE_BUCKET, err), items);
	});
}

function prepareConnectionDataItem(documentTypes, bucketName, database, isEmpty){
	let uniqueDocuments = _.uniq(documentTypes);
	let connectionDataItem = {
		dbName: bucketName,
		dbCollections: uniqueDocuments,
		isEmpty
	};

	return connectionDataItem;
}

function getDocumentKindDataFromInfer(data, probability) {
	let suggestedDocKinds = [];
	let otherDocKinds = [];
	let documentKind = {
		key: '',
		probability: 0	
	};

	if(data.isCustomInfer){
		let minCount = Infinity;
		let inference = data.inference.properties;

		for(let key in inference){
			if(inference[key]["%docs"] >= probability && inference[key].samples.length && typeof inference[key].samples[0] !== 'object'){
				suggestedDocKinds.push(key);

				if(data.excludeDocKind.indexOf(key) === -1){
					if(inference[key]["%docs"] >= documentKind.probability && inference[key].samples.length < minCount){
						minCount = inference[key].samples.length;
						documentKind.probability = inference[key]["%docs"];
						documentKind.key = key;
					}
				}
			} else {
				otherDocKinds.push(key);
			}
		}
	} else {
		let flavor = (data.flavorValue) ? data.flavorValue.split(',') : data.inference[0].Flavor.split(',');
		if(flavor.length === 1){
			suggestedDocKinds = Object.keys(data.inference[0].properties);
			let matсhedDocKind = flavor[0].match(/([\s\S]*?) \= "?([\s\S]*?)"?$/);
			documentKind.key = (matсhedDocKind.length) ? matсhedDocKind[1] : '';
		}
	}

	let documentKindData = {
		bucketName: data.bucketName,
		documentList: suggestedDocKinds,
		documentKind: documentKind.key,
		preSelectedDocumentKind: data.preSelectedDocumentKind,
		otherDocKinds
	};

	return documentKindData;
}

function generateCustomInferSchema(bucketName, documents, params){
	function typeOf(obj) {
		return {}.toString.call(obj).split(' ')[1].slice(0, -1).toLowerCase();
	};

	let sampleSize = params.sampleSize || 30;

	let inferSchema = {
		"#docs": 0,
		"$schema": "http://json-schema.org/schema#",
		"properties": {}
	};

	documents.forEach(item => {
		inferSchema["#docs"]++;
		
		for(let prop in item){
			if(inferSchema.properties.hasOwnProperty(prop)){
				inferSchema.properties[prop]["#docs"]++;
				inferSchema.properties[prop]["samples"].indexOf(item[prop]) === -1 && inferSchema.properties[prop]["samples"].length < sampleSize? inferSchema.properties[prop]["samples"].push(item[prop]) : '';
				inferSchema.properties[prop]["type"] = typeOf(item[prop]);
			} else {
				inferSchema.properties[prop] = {
					"#docs": 1,
					"%docs": 100,
					"samples": [item[prop]],
					"type": typeOf(item[prop])
				}
			}
		}
	});

	for (let prop in inferSchema.properties){
		inferSchema.properties[prop]["%docs"] = Math.round((inferSchema.properties[prop]["#docs"] / inferSchema["#docs"] * 100), 2);
	}
	return inferSchema;
}

function filterDocuments(documents){
	return documents.map(item =>{
		for(let prop in item) {
			if(prop && prop[0] === '_') {
				delete item[prop];
			}
		}
		return item;
	});
}

function filterSystemCollections(collections) {
	const listExcludedCollections = ["system.indexes"];

	return collections.filter((collection) => {
		return collection.name.length < 8 || collection.name.substring(0, 7) !== 'system.';
	});
}

function getSampleDocSize(count, recordSamplingSettings) {
	let per = recordSamplingSettings.relative.value;
	return (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
		: Math.round( count/100 * per);
}

function generateConnectionParams(connectionInfo, logger, cb){
	cb({
		url: `mongodb://${connectionInfo.userName}:${connectionInfo.password}@${connectionInfo.host}:${connectionInfo.port}`,
		options: {
			ssl: true
		}
	});
}

function getData(collection, sampleSettings, callback) {
	collection.count((err, count) => {
		const amount = !err && count > 0 ? count : 1000;								
		const size = +getSampleDocSize(amount, sampleSettings) || 1000;
		const iterations = size > 1000 ? Math.ceil(size / 1000) : 1;

		asyncLoop(iterations, function (i, callback) {
			const limit = i < iterations - 1 || size % 1000 === 0 ? 1000 : size % 1000;
			
			collection.find().limit(limit).toArray(callback);									
		}, callback);
	});
}

function asyncLoop(iterations, callback, done) {
	let result = [];
	let i = 0; 
	let handler = function (err, data) {
		if (err) {
			done(err);
		} else {
			result = result.concat(data);
			
			if (++i < iterations) {
				callback(i, handler);
			} else {
				done(err, result);
			}
		}
	};

	try {
		callback(i, handler);
	} catch (e) {
		done(e);
	}
}

function createError(code, message) {
	if (!message) {
		return null;
	}
	if (message.code) {
		code = message.code;
	}
	message = message.message || message.msg || message.errmsg || message;

	return {code, message};
}
