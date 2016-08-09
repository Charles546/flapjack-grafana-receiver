/*
 * flapjack grafana receiver
 *
 * A daemon created to monitor grafana boards and send events
 * to flapjack for alerting
 *
 */

var Request = require('request');
var Promise = require('bluebird');
var _ = require('lodash');
var Redis = require('then-redis');
var Winston = require('winston');

var CFG = require('./config.js');

var Datasources = null;
var DefaultDatasource = null;
var Events = [];
var Counter_ok = Counter_critical = Counter_warning = 0;
var RedisDB = null;

var Argv = require('minimist')(process.argv.slice(2));

function main() {
  if (Argv.h || Argv.help) {
    var helpText = [
      "Scan the grafana dashboards and generate alerts based on",
      "target definitions and send to flapjack redis server. See",
      "wiki for detail.",
      "",
      "Usage: node flapjack-grafana-receiver.js [ -h|--help ] [ -d|--daemon ] [ -v|--verbose]",
      "",
      "Optional:",
      " -h | --help:    print this message",
      " -d | --daemon:  run in daemon mode",
      " -v | --verbose: provide more verbose output to console",
      "",
      "Required configurations for redis connection, grafana endpoint",
      "should be provided in config.js",
      "",
    ].join("\n");
    console.log(helpText);
  } else {
    setupLogging();
    if (Argv.d || Argv.daemon) {
      daemon();
    } else {
      checkAll()
      .then(function() {
        return flushEvents();
      })
      .then(function() {
        return RedisDB.quit();
      })
      .catch(function(e) {
        log('error', e.message);
        log('error', e.stack);
      });
    }
  }
}
  

function daemon() {
  setInterval(flushEvents, CFG.flushInterval || 100);
  setInterval(checkAll, CFG.checkInterval || 300000);
}

function setupLogging() {
  var consoleLevel = ((Argv.verbose || Argv.v) ? 'verbose' : 'info');
  Winston.remove(Winston.transports.Console);
  Winston.add(Winston.transports.Console, { level: consoleLevel });
  if (CFG.log && CFG.log.file) {
    var level = CFG.log.level || 'info';
    Winston.add(Winston.transports.File, { file: CFG.log.file, level: level });
  }
}

function log() {
  var timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  var args = Array.from(arguments);
  args[1] = timestamp + ': ' + ( args[1] || '' );
  return Winston.log.apply(Winston, args);
} 

function grafana_call(command) {
  return new Promise(function(resolve, reject) {
    Request({
        url: CFG.grafana_endpoint + 'api/' + command,
        headers: {
          'Accept': 'applicaiton/json',
          'Content-Type': 'applicaiton/json',
          'Authorization': 'Bearer ' + CFG.grafana_access_token,
        }
      }, function(error, response, body) {
        if (!error && response.statusCode==200) {
          resolve(JSON.parse(body));
        } else {
          if (error)
            reject(error);
          else
            reject({statusCode: response.statusCode, response: response});
        }
      }
    );
  });
}

function graphite_call(datasource, target, from, until) {
  return new Promise(function(resolve, reject) {
    Request({
        url: datasource.url + '/render?format=json&target=' + target + '&from=' + ( from || '-1h' ) + '&until=' + ( until || ''),
        headers: {
          'Accept': 'applicaiton/json',
          'Content-Type': 'applicaiton/json',
        }
      }, function(error, response, body) {
        if (!error && response.statusCode==200) {
          resolve(JSON.parse(body));
        } else {
          if (error)
            reject(error);
          else
            reject({statusCode: response.statusCode, response: response});
        }
      }
    );
  });
}

function getDatasources() {
  return Promise.resolve(Datasources || grafana_call('datasources').then(function(d) {
      Datasources = d;
      DefaultDatasource = _.find(d, {isDefault: true});
      return d;
    }));
}

function getDatasource(name) {
  return getDatasources().then(function(dss) {
    return name ? _.find(dss, {name: name}) : DefaultDatasource;
  });
}

function checkPanel(board, panel) {
  return getDatasource(panel.datasource).then(function(datasource) {
    var checks = _.reduce(panel.targets, function(checks, line) {
      if (line.target && line.target.trim().startsWith('alias(')) {
        var name = line.target.substring(line.target.lastIndexOf(',')+1, line.target.lastIndexOf(')')).trim();
        name = name.substr(1,name.length-2); // remove the quotes
  
        if (name.endsWith('_bound')) {
          var target_ref = name.substring(0, name.indexOf('_'));
          var condition = name.substring(name.indexOf('_') + 1, name.lastIndexOf('_'));
          var target_threshold = line.target.substring(line.target.indexOf('(') + 1, line.target.lastIndexOf(','));
  
          var check = _.find(checks, {target: target_ref});
          if (!check) {
              check = {target: target_ref};
              checks.push(check);
          }
  
          check[condition] = target_threshold;
        }
      }
      return checks;
    }, []);

    return Promise.all(_.map(checks, function(check) {
      var target_data = _.find(panel.targets, {refId: check.target}).target;
      return Promise.all([
        graphite_call(datasource, target_data),
        check.lower && graphite_call(datasource, check.lower),
        check.upper && graphite_call(datasource, check.upper),
      ]).spread(function(data, lower, upper) {
        var checktime = Math.round((new Date()).getTime()/1000) - 180;  // TODO: ensure it is UTC
        _.forEach(data, function(series) {
          var last_item = _.findLast(series.datapoints, function(item) { return item[0] != null; });
          var lower_value = null;
          var upper_value = null;
          if (lower) {
            var left_threshold = _.findLast(lower[0].datapoints, function(t_item) { return t_item[1] <= last_item[1]; });
            var right_threshold = _.find(lower[0].datapoints, function(t_item) { return t_item[1] >= last_item[1]; });
            if (left_threshold && left_threshold[0] != null && right_threshold && right_threshold[0] != null) {
              lower_value = (left_threshold[0] + right_threshold[0])/2;
            }
          }
          if (upper) {
            var left_threshold = _.findLast(upper[0].datapoints, function(t_item) { return t_item[1] <= last_item[1]; });
            var right_threshold = _.find(upper[0].datapoints, function(t_item) { return t_item[1] >= last_item[1]; });
            if (left_threshold && left_threshold[0] != null && right_threshold && right_threshold[0] != null) {
              upper_value = (left_threshold[0] + right_threshold[0])/2;
            }
          }

          var evt = {
            entity: 'grafana.' + board + '.' + panel.title.replace(/ /g,'_'),
            check: series.target,
            type: 'service',
            details: 'check grafana board for detail: ' + CFG.grafana_endpoint + 'dashboard/db/' + board,
            time: checktime,
          };

          if (
              last_item == null || last_item[1] < checktime ||
              ( lower && lower_value == null ) ||
              ( upper && upper_value == null )
          ) {
            evt.state = 'warning';
            evt.summary = 'the value of ' + series.target + ' is missing for more than 180 seconds';
            Counter_warning ++;
          } else if (lower && last_item[0] < lower_value) {
            evt.state = 'critical';
            evt.summary = 'the value of ' + series.target + '(' + last_item[0] + ') is beyond the lower bound (' + lower_value + ')';
            Counter_critical ++;
          } else if (upper && last_item[0] > upper_value) {
            evt.state = 'critical';
            evt.summary = 'the value of ' + series.target + '(' + last_item[0] + ') is beyond the lower bound (' + lower_value + ')';
            Counter_critical ++;
          } else {
            evt.state = 'ok';
            evt.summary = 'the value of ' + series.target + ' is within range';
            Counter_ok ++;
          }
          Events.push(evt);
        });
      });
    }));
  });
}

function checkBoard(board) {
  log('info', 'processing board: ' + board);
  return grafana_call('dashboards/db/' + board)
  .then(function(boardObj) {
    return Promise.all(_.reduce(boardObj.dashboard.rows, function(checkings, row) {
      _.forEach(row.panels, function(panel) {
        checkings.push(checkPanel(board, panel));
      });
      return checkings;
    }, []));
  })
  .catch(function(e) {
    log('error', e.message);
    log('error', e.stack);
  });
}

function checkAll() {
  return grafana_call('search?tag=alert')
  .then(function(boards) {
    log('info', 'found ' + boards.length + ' tagged board(s)');
    return Promise.all(_.map(boards, function(item) {
      return checkBoard(item.uri.substr(item.uri.lastIndexOf('/')+1));
    }));
  });
}

function flushEvents() {
  if (!RedisDB) {
    RedisDB = Redis.createClient(CFG.redis);
  }

  if (Events.length) {
    log('info', 'sending ' + Events.length + ' event(s)');
    log('info', 'Ok ' + Counter_ok);
    log('info', 'Warning ' + Counter_warning);
    log('info', 'Critical ' + Counter_critical);
    RedisDB.multi();
    _.forEach(Events, function(evt) {
      RedisDB.lpush("events", JSON.stringify(evt));
    });
    return RedisDB.exec()
    .then(function() {
      Events = [];
      Counter_ok = Counter_critical = Counter_warning = 0;
    });
  }
}

main();

