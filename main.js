var AWS = require('aws-sdk'),
	util = require('util'),
	Promise = require('bluebird'),
    conf = Promise.promisifyAll(require('./lib/configHelper')),
    s3 = Promise.promisifyAll(require('node-s3-encryption-client')),
    awsS3 = Promise.promisifyAll(new AWS.S3()),
    sftpHelper = require('./lib/sftpHelper'),
    json2csv = require('./lib/jsontocsv')
    sqs = Promise.promisifyAll(new AWS.SQS());
var objIsCSV  = true;

exports.handle = function(event, context) {
	console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
    var srcBucket = event.Records[0].s3.bucket.name;
    var srcKey    = event.Records[0].s3.object.key;
    
    // determine whether a csv a CSV
    if (srcKey.match(/\.csv$/) === null) {
        var msg = "Key " + srcKey + " is not a csv file, attempting CTR conversion";
        objIsCSV = false;
        console.log(msg);
    }
	if (event.Records) {
    return exports.newS3Object(event, context);
  } else {
    console.log('No upload or Item is not a valid report or CTR.');
  }
};

exports.pollSqs = function(context) {
  return sqs.getQueueUrlAsync({
    QueueName: context.functionName
  })
  .then(function(queueData) {
    return Promise.mapSeries(
      Array.apply(null, {length: 10}).map(Number.call, Number),
      function(i) {
        return sqs.receiveMessageAsync({
          QueueUrl: queueData.QueueUrl,
          MaxNumberOfMessages: 10
        })
        .then(function(messages) {
          return Promise.mapSeries(
            messages.Messages || [],
            function(message) {
              return internalNewS3Object(JSON.parse(message.Body), context)
              .then(function(results) {
                return sqs.deleteMessageAsync({
                  QueueUrl: queueData.QueueUrl,
                  ReceiptHandle: message.ReceiptHandle
                })
                .then(function(data) {
                  return results;
                });
              });
            }
          );
        });
      }
    );
  });
};

function internalNewS3Object(event, context) {
  return Promise.try(function() {
	  console.info("Retrieving sftp variables");
	  return conf.getConfigAsync(context)
    .then(function(config) {
      return Promise.map(
        event.Records,
        function(record) {
          var fullS3Path = record.s3.bucket.name + '/' + decodeURIComponent(record.s3.object.key);
          console.info("Object path: " + fullS3Path + " | config s3 Loc: " + config["s3Location"]);
          var newObjectS3Path = exports.getFilePathArray(fullS3Path);
          return s3.getObjectAsync({
            Bucket: record.s3.bucket.name,
            Key: decodeURIComponent(record.s3.object.key)
          })
          .then(function(objectData) {
            if (!objectData.Metadata || objectData.Metadata.synched != "true") {
            	console.info("New Object path: " + newObjectS3Path);
            	var configKeys = Object.keys(config)//.filter(function(key) {
            	if (configKeys.length === 0) console.warn("No configured SFTP destination for " + fullS3Path);
                var s3Location = config["s3Location"];
                if (s3Location) {
                	console.info("Configkeys: " + Object.keys(config));
                  var configS3Path = exports.getFilePathArray(s3Location);
                  //return configS3Path.join('/') == newObjectS3Path.slice(0, configS3Path.length).join('/');
                };
                var bodydata = objectData.Body;
                if (!objIsCSV){
                	bodydata = json2csv.jsonconvert(objectData.Body.toString("utf8"));
                	};
                }
                var configS3Path = exports.getFilePathArray(config["s3Location"]);
                var sftpDirPath = exports.getFilePathArray(config["sftpLocation"]);
                console.info("configS3Path: " + configS3Path + " | sftpDirPath:" + sftpDirPath);
                return exports.getSftpConfig(config)
                  .then(function(sftpConfig) {
                    return sftpHelper.withSftpClient(sftpConfig, function(sftp) {
                      var sftpFileName = sftpDirPath.concat(newObjectS3Path[newObjectS3Path.length-1].replace(/:/g,'_')).join('/');
                      if (!objIsCSV){
                    	  sftpFileName += ".csv";
                      }
                      console.info("Writing " + sftpFileName + "...");
                      return sftpHelper.writeFile(
                        sftp,
                        sftpFileName,
                        bodydata
                      )
                      .then(function() {
                        console.info("...done");
                        console.info("[" + sftpFileName + "]: Moved 1 files from S3 to SFTP");
                        return sftpFileName;
                      });
                    });
                  })
            })
          });
        }
      );
    });
  };

exports.newS3Object = function(event, context) {
  return internalNewS3Object(event, context)
  .then(function(result) {
    context.succeed(flatten(result));
  })
  .catch(function(err) {
    console.info("Writing failed message to queue for later processing." + err);
    return sqs.getQueueUrlAsync({
      QueueName: context.functionName
    })
    .then(function(queueData) {
      return sqs.sendMessageAsync({
        MessageBody: JSON.stringify(event),
        QueueUrl: queueData.QueueUrl
      });
    })
    .then(function(sqsData) {
      context.succeed(sqsData);
    })
    .catch(function(err) {
      console.error(err.stack || err);
      context.fail(err);
      throw err;
    });
  });
};

exports.getFilePathArray = function(filePath) {
  return (filePath || '').split('/').filter(function(s) { return s ? true : false });
};

exports.getSftpConfig = function(config) {
  return Promise.try(function() {
    if (!config["host"]) throw new Error("SFTP config not found");
    console.info("Host found: " + config["host"]);
    var sftpconfig = {
    		"host" : config["host"],
    		"port" : config["port"],
    		"username" : config["username"],
    		"password" : config["password"],
    };
    if (config["s3PrivateKey"]) {
      var bucketDelimiterLocation = config.sftpConfig.s3PrivateKey.indexOf("/");
      return s3.getObjectAsync({
        Bucket: config.sftpConfig.s3PrivateKey.substr(0, bucketDelimiterLocation),
        Key: config.sftpConfig.s3PrivateKey.substr(bucketDelimiterLocation + 1)
      })
      .then(function(objectData) {
        sftpconfig.privateKey = objectData.Body.toString();
        delete config.s3PrivateKey;
        return sftpconfig;
      });
    } else return sftpconfig;
  });
};

exports.scheduledEventResourceToStreamNames = function(resource) {
  return resource.substr(resource.toLowerCase().indexOf("rule/") + 5).split(".");
};

exports.syncSftpDir = function(sftp, sftpDir, s3Location, fileRetentionDays, topDir, isInDoneDir) {
  topDir = topDir || sftpDir;
  fileRetentionDays = fileRetentionDays || 14; // Default to retaining files for 14 days.
  return sftp.readdirAsync(sftpDir)
  .then(function(dirList) {
    return Promise.mapSeries(
      dirList,
      function(fileInfo) {
        return Promise.try(function() {
          if (fileInfo.longname[0] == 'd') {
            return exports.syncSftpDir(sftp, sftpDir + '/' + fileInfo.filename, s3Location, fileRetentionDays, topDir, isInDoneDir || fileInfo.filename == sftpHelper.DoneDir);
          } else if (isInDoneDir) {
            // Purge files from the .done folder based on the stream config
            var fileDate = new Date(fileInfo.attrs.mtime * 1000),
                purgeDate = new Date();
            purgeDate.setDate(purgeDate.getDate() - fileRetentionDays);
            if (fileDate < purgeDate) {
              return sftp.unlinkAsync(sftpDir + '/' + fileInfo.filename);
            }
          } else {
            return sftpHelper.processFile(sftp, sftpDir, fileInfo.filename, function(body) {
              var s3Path = exports.getFilePathArray(s3Location),
                  sftpPath = exports.getFilePathArray(sftpDir),
                  topDirPath = exports.getFilePathArray(topDir);
              var s3Bucket = s3Path.shift();
              for (var i = 0; i < topDirPath.length; i++) sftpPath.shift(); // Remove the origin path from the destination directory
              var destDir = s3Path.concat(sftpPath).join('/');
              if (destDir.length > 0) destDir += '/';
              console.info("Writing " + s3Bucket + "/" + destDir + fileInfo.filename + "...");
              return s3.putObjectAsync({
                Bucket: s3Bucket,
                Key: destDir + fileInfo.filename,
                Body: body,
                Metadata: {
                  "synched": "true"
                }
              })
              .then(function(data) {
                console.info("...done");
                return data;
              });
            });
          }
        });
      }
    );
  })
}

function flatten(arr) {
  return arr.reduce(function(a, b) {
    if (Array.isArray(b)) {
      return a.concat(flatten(b));
    } else if (b) {
      a.push(b);
      return a;
    } else {
      return a;
    }
  }, []);
}
