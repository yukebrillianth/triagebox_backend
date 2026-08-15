#!/usr/bin/env node
const { io } = require('socket.io-client');
const fs = require('fs');

const url = process.argv[2] || process.env.WS_URL || 'http://localhost:3001';
const logFile = process.argv[3] || process.env.WS_LOG || '/tmp/ws-events.log';

const EVENTS = [
  'victim.created',
  'victim.updated',
  'victim.priority_changed',
  'vital.updated',
  'node.status',
  'station.status',
  'alert.created',
  'activity.created',
  'kpi.updated',
];

fs.writeFileSync(logFile, '');
const socket = io(url, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  const line = `[connected] id=${socket.id} url=${url}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
});

socket.on('disconnect', (reason) => {
  const line = `[disconnected] ${reason}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
});

socket.on('connect_error', (err) => {
  const line = `[connect_error] ${err.message}\n`;
  fs.appendFileSync(logFile, line);
  process.stderr.write(line);
});

for (const name of EVENTS) {
  socket.on(name, (payload) => {
    const line =
      JSON.stringify({ event: name, payload, at: new Date().toISOString() }) +
      '\n';
    fs.appendFileSync(logFile, line);
    process.stdout.write(line);
  });
}

process.on('SIGINT', () => {
  socket.close();
  process.exit(0);
});
