const { createLogger, format, transports } = require('winston');

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `[${level.toUpperCase()}] ${timestamp} | ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'storage/logs/bot.log', level: 'info' }),
        new transports.File({ filename: 'storage/logs/error.log', level: 'error' })
    ]
});

module.exports = logger;
