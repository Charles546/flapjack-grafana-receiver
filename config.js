/*
 * flapjack grafana receiver
 *
 * A daemon created to monitor grafana boards and send events
 * to flapjack for alerting
 *
 * Store the configuration
 *
 */

var _ = require('lodash');

var DefaultConfig = {
  grafana_endpoint : 'http://url-to-grafana',
  grafana_access_token : '=== access token for grafana api ===',

  redis: {
    host: 'flapjack-redis-server',
    port: 6380,
  },

  // log: {
  //   file: 'path to the log file',
  //   level: one of 'info', 'warn', 'error', 'debug'
  // },

  // flushInterval: 100, // how often to find and flush events to redis
  // checkInterval: 300000, // how often to pull data from grafana and generate event
};

var Overrides;
try {
  Overrides = require('./local-config');
} catch(e) {
  console.error('Unable to load local-config:' + e.message);
}

module.exports = _.merge(DefaultConfig, Overrides);
 
