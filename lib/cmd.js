var path = require('path');
var Job = require('./job');

var runJob = function (json, cb) {
  var opts = JSON.parse(json);
  var results = {};
  var job = new Job(opts, results);
  
  job.run(function(err, result) {
    cb(JSON.stringify(result, null, '  '));
  });
};

module.exports = runJob;