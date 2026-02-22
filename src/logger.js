const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const { LOG_DIR } = require('./config'); // ambil dari config

// buat path absolut
const logDir = path.isAbsolute(LOG_DIR) ? LOG_DIR : path.join(__dirname, LOG_DIR);

// buat folder jika belum ada
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `[${level.toUpperCase()}] ${timestamp} | ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: path.join(logDir, 'bot.log'), level: 'info' }),
        new transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' })
    ]
});

logger.info(`Logger initialized ✅, logs directory: ${logDir}`);

module.exports = logger;