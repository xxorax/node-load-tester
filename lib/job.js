
var requestLib = require('request');
var async = require('async');
var _ = require('lodash');
var pkg = require('../package.json');
var DEFAULT_HEADERS = {
  'user-agent': pkg.name+'/'+pkg.version
};

//job class
function Job(job, finalResults) {
  this.opts = job;
  this.next = nexter();
  _.bindAll(this);

  // if(!this.opts.name)
  //   return this.cb("'name' required");
  if(!_.isArray(this.opts.sequence))
    throw "requires a 'sequence'";

  if(typeof this.opts.maxSockets !== 'number')
    this.opts.maxSockets = 5;
  if(typeof this.opts.connections === 'number')
    this.opts.maxSockets = this.opts.connections;

  if(typeof this.opts.runs !== 'number')
    this.opts.runs = Infinity;
  if(typeof this.opts.duration !== 'number')
    this.opts.duration = Infinity;

  if(this.opts.runs === Infinity &&
     this.opts.duration === Infinity)
    this.opts.runs = 1;

  if(_.isArray(this.opts.origins))
    this.origins = this.opts.origins;
  else if(typeof this.opts.origin === 'string')
    this.origins = [this.opts.origin];
  else
    throw "requires an 'origin'";

  this.opts.headers = _.defaults(this.opts.headers || {}, DEFAULT_HEADERS);

  var i;
  for (i = 0; i < this.origins.length; i++)
    if(!/^https?:\/\/[^\/]+$/.test(this.origins[i]))
      throw "Invalid origin: '"+this.origins[i]+"', must be http[s]://host:port";
  
  this.opts.sequence.map(this.prepareSequenceRequest, this);

  //fork 'request' with n connections
  this.request = requestLib.defaults({
    pool: {maxSockets: this.opts.maxSockets}
  });

  this.stopped = false;
  this.running = 0;
  this.runned = 0;
  this.results = [];
  this.finalResults = finalResults;
}

Job.prototype.prepareSequenceRequest = function (sequenceRequest) {
  
  if(!_.isObject(sequenceRequest))
    throw "sequence request item (#{req}) must be an object";
  
  if (sequenceRequest.requests) {
    // sub requests
    if(!_.isArray(sequenceRequest.requests))
      throw "request sequence request group property must be an array of requests";
    
    sequenceRequest.loop = sequenceRequest.loop || 1;
    if (!sequenceRequest.name)
      throw "sequence request group must have a name";
    
    sequenceRequest.requests.map(this.prepareSequenceRequest, this);
    return sequenceRequest;
  }
  
  // std request
  var req = sequenceRequest;

  req.timeout = req.timeout || this.opts.timeout || 5000;
  req.method  = req.method || 'GET';
  req.path  = req.path || '';
  req.headers  = req.headers || {};
  req.expect = req.expect || { code: 200 };
  req.followRedirect  = req.followRedirect || false;

  if(req.expect.code && typeof req.expect.code !== 'number')
    throw "sequence request property 'code' must be a number";

  if(req.expect.match) {
    if(typeof req.expect.match !== 'string')
      throw "sequence request property 'match' must be a string";
    try {
      req.expect._re = new RegExp(req.expect.match);
    } catch(e) {
      throw "sequence request property 'match' contains an invalid regex: "+req.expect.match;
    }
  }

  if(req.expect.contains && typeof req.expect.contains !== 'string')
    throw "sequence request property 'contains' must be a string";

  if(req.forms && _.isArray(req.forms))
    req.form = this.next(req.forms);

  if(req.method === 'GET' && req.form)
    throw "sequence request has method GET and form data";
  
  return sequenceRequest;
};


Job.prototype.run = function(callback) {
  
  this.cb = callback;

  this.startTime = Date.now();

  for(var b = 0; b < Math.min(this.opts.maxSockets, this.opts.runs); ++b)
    this.runSequence();

  if(this.opts.duration !== Infinity)
    setTimeout(this.stop, this.opts.duration);
};

Job.prototype.stop = function() {
  this.stopped = true;
};

Job.prototype.runSequence = function() {
  if(this.stopped) return;
  if(this.running >= this.opts.runs) return;
  this.running++;

  //bind this cookie jar to this sequence
  async.mapSeries(
    this._makeRequests(this.opts.sequence),
    this.runRequest.bind(this, this.opts.sequence, requestLib.jar()),
    this.ranSequence);
};

Job.prototype._makeRequests = function (sequence) {
  var requests = [];
  
  for (var i = 0; i < sequence.length; i++) {
    var sequenceRequest = sequence[i];
    
    if (!sequenceRequest.requests) {
      requests.push(this._prepareRequest(sequenceRequest, sequenceRequest));
      continue;
    }
    
    if (!_.isArray(sequenceRequest.requests)) {
      throw 'error';
    }
    
    var r;
    for (var n = sequenceRequest.loop; n > 0; n--) {
      r = Math.round(Math.random() * (sequenceRequest.requests.length - 1));
      requests.push(this._prepareRequest(sequenceRequest.requests[r], sequenceRequest));
    }
  }
  
  return requests;
};

Job.prototype._prepareRequest = function (request, sequenceRequest) {
  var req = _.clone(request);
  req.sequenceRequest = sequenceRequest;
  return req;
};



Job.prototype.ranSequence = function(err, results) {

  if(err)
    return this.done(err);

  this.results = this.results.concat(results);
  this.runned++;
  
  if((!this.stopped || this.runned < this.running) &&
     (this.runned < this.opts.runs))
    process.nextTick(this.runSequence);
  else
    this.done();
};

Job.prototype._buildRequest = function (sequence, jar) {
  var req = _.pick(sequence, 'method', 'form', 'followRedirect', 'timeout');
  
  req.url = this.next(this.origins) + sequence.path;
  req.jar = jar;
  req.headers = _.defaults({}, sequence.headers, this.opts.headers);
  
  return req;
};

Job.prototype.runRequest = function(sequence, jar, request, done) {
  var self = this;
  var req = this._buildRequest(request);
  var expect = request.expect;
  var sequenceRequest = request.sequenceRequest;
  
  var delay = this.requestDelay;
  var responseTime = Date.now();
  
  this.request(req, function(err, res, body) {
    if(err)
      err = err.toString();
    else if(!res)
      err = '(no response)';
    else if(expect.code && expect.code !== res.statusCode)
      err = 'expected code: ' + expect.code +
                     ', got: ' + res.statusCode +
                     ' (for ' + self._getSequenceRequestKey(sequenceRequest) + ')';
    else if(expect._re && !expect._re.test(body))
      err = 'expected body to match regex: ' + expect._re;
    else if(expect.contains && body.indexOf(expect.contains) === -1)
      err = 'expected body to contain string: ' + expect.contains;

    var results = {
      sequenceRequest: sequenceRequest,
      responseTime: Date.now() - responseTime,
      err: err
    };

    if(delay)
      setTimeout(done.bind(null, null, results), delay);
    else
      done(null, results);
  });
};

Job.prototype._getSequenceRequestKey = function (sequenceRequest) {
  if (sequenceRequest.name) {
    return sequenceRequest.name;
  } else {
    return sequenceRequest.method+" "+sequenceRequest.path;
  }
};

Job.prototype._addError = function (finalResults, err) {
  if(finalResults.errors[err])
    finalResults.errors[err]++;
  else
    finalResults.errors[err] = 1;
};

Job.prototype.done = function(err) {
  if(err)
    return this.cb(err);


  var finalResults = {
        paths: {}, errors: {}, pass: 0, fail: 0, total: 0,
        totalTime: Date.now() - this.startTime,
        totalRequest: this.results.length,
      },
      finalTimes = [], s,r, res, path, pathData;

  for(s = 0; s < this.opts.sequence.length; ++s) {

    var sequenceRequest = this.opts.sequence[s],
      key = this._getSequenceRequestKey(sequenceRequest);

    //add to path
    if (!finalResults.paths[key]) {
      finalResults.paths[key] = { pass: 0, fail: 0, total: 0, times: [] };
    }
    
    pathData = finalResults.paths[key];

    //calculate
    for(r = 0; r < this.results.length; ++r) {
      res = this.results[r];
      if (res.sequenceRequest !== sequenceRequest) {
        if (res.unknown !== 0) {
          res.unknown = 1;
        }
        continue;
      }
      res.unknown = 0;
      //if(!res) res = {err:'(missing)'};
      pathData.total++;
      if(!res.err) {
        pathData.pass++;
      } else {
        this._addError(finalResults, res.err);
        pathData.fail++;
      }
      pathData.times.push(res.responseTime);
    }
  }
  
  for(r = 0; r < this.results.length; ++r) {
    res = this.results[r];
    if (res.unknown) {
      this._addError(finalResults, '(unknow request)');
    }
  }

  //calculate totals
  for(path in finalResults.paths) {
    pathData = finalResults.paths[path];
    pathData.avgResponseTime = avg(pathData.times);
    //delete array
    delete pathData.times;
    finalTimes.push(pathData.avgResponseTime);
    finalResults.pass += pathData.pass;
    finalResults.fail += pathData.fail;
    finalResults.total += pathData.total;
  }

  finalResults.avgResponseTime = avg(finalTimes);
  this.results = finalResults;
  this.cb(null, finalResults);
};

Job.prototype.toJSON = function() {
  return undefined;
};

//job runner
module.exports = Job;

//helper
var nexter = function() {
  //create 'next' functions which can get thrown away along with their data
  var next = function(arr) {
    var i = next.arrs.indexOf(arr);
    if(i === -1) {
      next.arrs.push(arr);
      i = next.arrs.indexOf(arr);
      next.counts[i] = 0;
    }
    return arr[ next.counts[i]++ % arr.length ];
  };
  next.counts = [];
  next.arrs   = [];
  return next;
};

var avg = function(arr) {
  return Math.round(arr.reduce(function(p,c) { return p+c; }, 0)/arr.length);
};
var rand = function(arr) {
  return arr[Math.floor(Math.random()*arr.length)];
};

