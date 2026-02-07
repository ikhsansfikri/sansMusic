require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection
} = require('@discordjs/voice');
const winston = require('winston');
const { spawn } = require('child_process');


// --- CONFIGURATION ---
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '.';
const YT_DLP_COMMAND = 'yt-dlp'; // Pastikan yt-dlp sudah terinstall global

// --- SETUP LOGGER ---
const logFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot_activity.log' })
    ],
});

if (!TOKEN) {
    logger.error("❌ Error: Token not found in .env file!");
    process.exit(1);
}

// --- CLIENT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- QUEUE STRUCTURE ---
const queue = new Map();

// --- HELPER: GET SONG INFO (Raw Spawn) ---
function getSongInfo(query) {
    return new Promise((resolve, reject) => {
        const process = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--default-search', 'ytsearch',
            '--no-playlist',
            '--no-warnings',
            '--geo-bypass',
            query
        ]);

        let data = '';
        process.stdout.on('data', (chunk) => data += chunk);

        process.on('close', (code) => {
            if (code === 0 && data) {
                try {
                    const info = JSON.parse(data);
                    const result = info.entries ? info.entries[0] : info;

                    resolve({
                        title: result.title,
                        url: result.webpage_url,
                        webpage_url: result.webpage_url,
                        duration_string: result.duration_string,
                        id: result.id,
                        thumbnail: result.thumbnail
                    });
                } catch (e) {
                    logger.error(`Error parsing info JSON: ${e.message}`);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

// --- HELPER: AUTOPLAY RECOMMENDATION (Mix Playlist) ---
function getRelatedSong(videoId) {
    return new Promise((resolve) => {
        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;

        const process = spawn(YT_DLP_COMMAND, [
            '--dump-json',
            '--flat-playlist',
            '--playlist-end', '2',
            '--no-warnings',
            mixUrl
        ]);

        let data = '';
        process.stdout.on('data', (chunk) => data += chunk);

        process.on('close', (code) => {
            if (code === 0 && data) {
                try {
                    const lines = data.trim().split('\n');
                    if (lines.length >= 2) {
                        const rec = JSON.parse(lines[1]);
                        resolve({
                            title: rec.title,
                            url: rec.url || `https://www.youtube.com/watch?v=${rec.id}`,
                            webpage_url: rec.url || `https://www.youtube.com/watch?v=${rec.id}`,
                            duration_string: rec.duration_string || 'Unknown',
                            id: rec.id
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

// --- HELPER: PLAY SONG (STREAMING) ---
async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);

    // Kill proses lama (Cleanup)
    if (serverQueue.streamProcess) {
        try {
            serverQueue.streamProcess.removeAllListeners('error');
            serverQueue.streamProcess.kill('SIGKILL');
        } catch (e) { }
        serverQueue.streamProcess = null;
    }

    // --- LOGIC AUTOPLAY / EMPTY QUEUE ---
    if (!song) {
        if (serverQueue.lastPlayed) {
            serverQueue.textChannel.send('🔄 Queue ended. Fetching recommendation...');
            const recommendation = await getRelatedSong(serverQueue.lastPlayed.id);

            if (recommendation) {
                const newSong = {
                    ...recommendation,
                    isAutoplay: true
                };
                serverQueue.songs.push(newSong);
                playSong(guildId, serverQueue.songs[0]);
                logger.info(`Autoplay triggered: "${newSong.title}"`);
                return;
            }
        }

        serverQueue.timeout = setTimeout(() => {
            const connection = getVoiceConnection(guildId);
            if (connection) {
                connection.destroy();
                queue.delete(guildId);
                serverQueue.textChannel.send('💤 No activity for 30 seconds. Leaving voice channel.');
                logger.info(`Auto-disconnected from guild ${guildId}.`);
            }
        }, 30 * 1000);
        return;
    }

    if (serverQueue.timeout) {
        clearTimeout(serverQueue.timeout);
        serverQueue.timeout = null;
    }

    try {
        // Spawn yt-dlp untuk streaming
        const child = spawn(YT_DLP_COMMAND, [
            song.webpage_url,
            '-o', '-',
            '-f', 'bestaudio',
            '-q',
            '--limit-rate', '100K',
            '--no-playlist',
            '--no-warnings',
            '--buffer-size', '16K'
        ], {
            // PERBAIKAN DI SINI:
            // ignore: stdin (karena kita tidak kirim input apa2)
            // pipe: stdout (output suara)
            // ignore: stderr (agar log tidak kotor, atau ganti 'inherit' untuk debug)
            stdio: ['ignore', 'pipe', 'ignore']
        });

        serverQueue.streamProcess = child;

        // --- PERBAIKAN UTAMA ---
        // Hapus child.stdin.on('error') karena stdin dimatikan ('ignore')

        // Cukup handle stdout error jika ada
        if (child.stdout) {
            child.stdout.on('error', () => { });
        }

        // Handle process error umum (misal: command not found)
        child.on('error', (error) => {
            logger.warn(`Child Process Error: ${error.message}`);
            // Jika error fatal, skip lagu
            if (!serverQueue.player.state.status === AudioPlayerStatus.Playing) {
                serverQueue.songs.shift();
                playSong(guildId, serverQueue.songs[0]);
            }
        });

        const resource = createAudioResource(child.stdout);
        serverQueue.player.play(resource);

        serverQueue.lastPlayed = song;

        if (song.isAutoplay) {
            serverQueue.textChannel.send(`🎵 Now playing: **${song.title}**`);
        } else {
            serverQueue.textChannel.send(`🎵 Now playing: **${song.title}**`);
        }

        logger.info(`Start playing: "${song.title}"`);

    } catch (error) {
        logger.error(`PlaySong Error: ${error.message}`);
        serverQueue.songs.shift();
        playSong(guildId, serverQueue.songs[0]);
    }
}

client.once(Events.ClientReady, () => {
    logger.info(`✅ Bot is online as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: '.help | .play', type: ActivityType.Listening }],
        status: 'online',
    });
});

// --- EVENT: VOICE STATE UPDATE (Leave on Empty) ---
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = oldState.guild.id;
    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    const botChannel = oldState.guild.members.me.voice.channel;
    if (!botChannel) return;

    if (botChannel.members.size === 1) {
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            if (serverQueue.streamProcess) {
                try {
                    serverQueue.streamProcess.removeAllListeners('error');
                    serverQueue.streamProcess.kill('SIGKILL');
                } catch (e) { }
            }
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.textChannel.send('👋 Everyone left the channel.');
            queue.delete(guildId);
        }
        connection.destroy();
        logger.info(`Left guild ${guildId} because voice channel is empty.`);
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const guildId = message.guild.id;
    const userTag = message.author.tag;

    logger.info(`User [${userTag}] executed [${command}]`);

    // --- PLAY COMMAND ---
    if (command === 'play') {
        if (!args.length) return message.reply('❌ Please provide a song title or link!');
        if (!message.member.voice.channel) return message.reply('❌ Join a voice channel first!');

        const query = args.join(' ');
        const voiceChannel = message.member.voice.channel;

        message.reply(`🔎 Searching: **${query}**...`);

        const songInfo = await getSongInfo(query);
        if (!songInfo) {
            return message.reply('❌ Song not found.');
        }

        const song = {
            title: songInfo.title,
            url: songInfo.url,
            webpage_url: songInfo.webpage_url,
            duration: songInfo.duration_string,
            id: songInfo.id
        };

        let serverQueue = queue.get(guildId);

        if (!serverQueue) {
            const player = createAudioPlayer();
            serverQueue = {
                textChannel: message.channel,
                voiceChannel: voiceChannel,
                connection: null,
                player: player,
                songs: [],
                lastPlayed: null,
                timeout: null,
                streamProcess: null
            };

            queue.set(guildId, serverQueue);
            serverQueue.songs.push(song);

            try {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
                serverQueue.connection = connection;
                connection.subscribe(player);

                player.on(AudioPlayerStatus.Idle, () => {
                    if (serverQueue.streamProcess) {
                        try {
                            serverQueue.streamProcess.removeAllListeners('error');
                            serverQueue.streamProcess.kill('SIGKILL');
                        } catch (e) { }
                    }
                    serverQueue.songs.shift();
                    playSong(guildId, serverQueue.songs[0]);
                });

                player.on('error', error => {
                    logger.error(`Player Error: ${error.message}`);
                    serverQueue.songs.shift();
                    playSong(guildId, serverQueue.songs[0]);
                });

                playSong(guildId, serverQueue.songs[0]);
            } catch (err) {
                logger.error(`Connection Error: ${err.message}`);
                queue.delete(guildId);
                return message.reply('❌ Failed to connect to voice channel.');
            }
        } else {
            serverQueue.songs.push(song);
            if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                playSong(guildId, serverQueue.songs[0]);
            } else {
                return message.reply(`✅ Added to queue: **${song.title}**`);
            }
        }
    }

    // --- SKIP COMMAND ---
    else if (command === 'next' || command === 'skip') {
        const serverQueue = queue.get(guildId);
        if (!serverQueue || !serverQueue.player) return message.reply('❌ No music playing.');

        const isLastSong = serverQueue.songs.length <= 1;

        if (isLastSong) {
            message.reply('⏭️ Skipped! (Queue empty, finding Autoplay... ✨)');
        } else {
            message.reply('⏭️ Skipped!');
        }

        logger.info(`Song skipped by ${userTag}`);

        if (serverQueue.streamProcess) {
            try {
                serverQueue.streamProcess.removeAllListeners('error');
                serverQueue.streamProcess.kill('SIGKILL');
            } catch (e) { }
        }

        serverQueue.player.stop();
    }

    // --- STOP COMMAND ---
    else if (command === 'stop') {
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            if (serverQueue.streamProcess) {
                try {
                    serverQueue.streamProcess.removeAllListeners('error');
                    serverQueue.streamProcess.kill('SIGKILL');
                } catch (e) { }
            }
            serverQueue.songs = [];
            serverQueue.lastPlayed = null;
            serverQueue.player.stop();
            message.reply('🛑 Stopped.');
        }
    }

    // --- LEAVE COMMAND ---
    else if (command === 'leave') {
        const connection = getVoiceConnection(guildId);
        const serverQueue = queue.get(guildId);

        if (serverQueue) {
            if (serverQueue.streamProcess) {
                try {
                    serverQueue.streamProcess.removeAllListeners('error');
                    serverQueue.streamProcess.kill('SIGKILL');
                } catch (e) { }
            }
            queue.delete(guildId);
        }

        if (connection) {
            connection.destroy();
            message.reply('👋 Bye!');
        }
    }

    // --- OTHER COMMANDS ---
    else if (command === 'queue') {
        const serverQueue = queue.get(guildId);
        if (!serverQueue || serverQueue.songs.length === 0) return message.reply('📭 Queue is empty.');

        const list = serverQueue.songs.map((s, i) => `${i + 1}. ${s.title} ${s.isAutoplay ? '✨' : ''}`).slice(0, 10).join('\n');
        message.reply(`📜 **Queue List:**\n${list}`);
    }
    else if (command === 'pause') {
        const serverQueue = queue.get(guildId);
        if (serverQueue && serverQueue.player) {
            serverQueue.player.pause();
            message.reply('⏸️ Paused.');
        }
    }
    else if (command === 'resume') {
        const serverQueue = queue.get(guildId);
        if (serverQueue && serverQueue.player) {
            serverQueue.player.unpause();
            message.reply('▶️ Resumed.');
        }
    }

    else if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🎶 Bot Commands')
            .addFields(
                { name: '!play <title/link>', value: 'Plays a song.' },
                { name: '!skip', value: 'Skips current song.' },
                { name: '!pause / !resume', value: 'Pause or Resume.' },
                { name: '!queue', value: 'Shows current queue.' },
                { name: '!stop', value: 'Stops music completely.' },
                { name: '!leave', value: 'Disconnects bot.' }
            )
            .setFooter({ text: 'Powered by San\'sMusic' });

        message.channel.send({ embeds: [helpEmbed] });
    }
});

client.login(TOKEN);