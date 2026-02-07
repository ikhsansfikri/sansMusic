const { spawn } = require('child_process');
const { YT_DLP_COMMAND } = require('../config');
const logger = require('../logger');

function ytSearch(query, mode) {
    return new Promise(resolve => {
        const p = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--default-search', mode,
            '--no-playlist',
            '--no-warnings',
            query
        ]);

        let data = '';
        p.stdout.on('data', c => data += c);

        p.on('close', () => {
            try {
                const info = JSON.parse(data);
                const r = info.entries ? info.entries[0] : info;
                console.log(`[SEARCH] Found: ${r.title}`);
                logger.info(`[SEARCH] Found: ${r.title}`);
                resolve({
                    title: r.title,
                    id: r.id,
                    url: r.webpage_url,
                    webpage_url: r.webpage_url,
                    duration: r.duration_string || 'Live',
                    thumbnail: r.thumbnail,
                    duration_seconds: r.duration || null,
                });
            } catch (err) {
                console.log(`[SEARCH] Failed to parse: ${query}`);
                logger.error(`[SEARCH] Failed to parse: ${query} - ${err.message}`);
                resolve(null);
            }
        });
    });
}

async function getSongInfo(query) {
    console.log(`[SEARCH] Searching for: ${query}`);
    logger.info(`[SEARCH] Searching for: ${query}`);
    let result = await ytSearch(query, 'ytsearchmusic');
    if (result) return result;
    return await ytSearch(query, 'ytsearch');
}

module.exports = { getSongInfo, ytSearch };
