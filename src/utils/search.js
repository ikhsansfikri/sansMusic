const { spawn } = require('child_process');
const { YT_DLP_COMMAND } = require('../config');
const logger = require('../logger');

function ytSearch(query, mode) {
    return new Promise(resolve => {
        const p = spawn(YT_DLP_COMMAND, [
            '--dump-single-json',
            '--default-search', mode,
            '--no-playlist',
            '--no-warnings',
            query
        ]);

        let data = '';
        p.stdout.on('data', c => data += c);

        p.on('close', () => {
            try {
                if (!data || !data.trim()) {
                    return resolve(null);
                }

                const info = JSON.parse(data);

                if (!info) return resolve(null);

                let r = null;

                if (info.entries && Array.isArray(info.entries)) {
                    r = info.entries.find(e => e);
                } else {
                    r = info;
                }

                if (!r) return resolve(null);

                console.log(`[SEARCH] Found: ${r.title}`);

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
                logger.error(`[SEARCH] Failed to parse: ${query} - ${err.message} - Output: ${data}`);
                resolve(null);
            }
        });
    });
}

async function getSongInfo(query) {
    logger.info(`[SEARCH] Searching for: ${query}`);
    const modes = ['ytsearchmusic', 'ytsearch'];

    for (const mode of modes) {
        const result = await ytSearch(query, mode);
        if (result) return result;
    }
    logger.warn(`[SEARCH] No results found for: ${query}`);
    return null;
}

module.exports = { getSongInfo, ytSearch };
