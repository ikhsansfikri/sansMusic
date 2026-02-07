require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection
} = require('@discordjs/voice');
const youtubedl = require('youtube-dl-exec');
const winston = require('winston');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';

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

// --- LOCATE YT-DLP BINARY ---
const ytDlpPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

if (!fs.existsSync(ytDlpPath)) {
    logger.error(`❌ Critical Error: Binary yt-dlp tidak ditemukan di: ${ytDlpPath}`);
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

// --- HELPER: GET SONG INFO ---
async function getSongInfo(query) {
    try {
        const output = await youtubedl(query, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            defaultSearch: 'ytsearch'
        });

        if (output.entries) {
            return output.entries[0];
        }
        return output;
    } catch (error) {
        logger.error(`Error fetching song info: ${error.message}`);
        return null;
    }
}

// --- HELPER: AUTOPLAY RECOMMENDATION ---
async function getRelatedSong(previousSongUrl) {
    try {
        const videoId = previousSongUrl.split('v=')[1];
        if (!videoId) return null;

        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;

        const output = await youtubedl(mixUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            playlistEnd: 2,
            flatPlaylist: true
        });

        if (output.entries && output.entries.length >= 2) {
            const rec = output.entries[1];
            return await getSongInfo(`https://www.youtube.com/watch?v=${rec.id}`);
        }
        return null;
    } catch (error) {
        logger.error(`Autoplay Error: ${error.message}`);
        return null;
    }
}

// --- HELPER: PLAY SONG (STREAMING) ---
async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);

    // Kill proses lama
    if (serverQueue.streamProcess) {
        serverQueue.streamProcess.removeAllListeners('error');
        serverQueue.streamProcess.kill('SIGKILL');
        serverQueue.streamProcess = null;
    }

    // --- LOGIC AUTOPLAY ---
    if (!song) {
        if (serverQueue.lastPlayed) {
            logger.info(`Autoplay triggered in guild ${guildId}.`);
            serverQueue.textChannel.send('🔄 Finding next song...');
            const recommendation = await getRelatedSong(serverQueue.lastPlayed.webpage_url);

            if (recommendation) {
                const newSong = {
                    title: recommendation.title,
                    url: recommendation.url,
                    webpage_url: recommendation.webpage_url,
                    duration: recommendation.duration_string,
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
        const child = spawn(ytDlpPath, [
            song.webpage_url,
            '-o', '-',
            '-f', 'bestaudio',
            '-q',
            '--limit-rate', '100K',
            '--no-playlist'
        ]);

        serverQueue.streamProcess = child;

        child.on('error', (error) => {
            logger.warn(`Child Process Error (Ignored): ${error.message}`);
        });

        // Mencegah error "Broken Pipe"
        child.stdin.on('error', () => { });
        child.stdout.on('error', () => { });

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
        activities: [{ name: '!help | !play', type: ActivityType.Listening }],
        status: 'online',
    });
});

// --- EVENT: VOICE STATE UPDATE (Leave on Empty) ---
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // 1. Cek apakah bot sedang terhubung di guild ini
    const guildId = oldState.guild.id;
    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    // 2. Ambil channel tempat bot berada saat ini
    const botChannel = oldState.guild.members.me.voice.channel;

    // Jika bot entah kenapa tidak terdeteksi di channel, abaikan
    if (!botChannel) return;

    // 3. Cek jumlah member di channel tersebut
    // Jika members.size == 1, berarti hanya bot sendirian (semua manusia sudah keluar)
    if (botChannel.members.size === 1) {
        const serverQueue = queue.get(guildId);

        if (serverQueue) {
            // Kill proses download jika ada
            if (serverQueue.streamProcess) {
                serverQueue.streamProcess.removeAllListeners('error');
                serverQueue.streamProcess.kill('SIGKILL');
            }
            // Bersihkan antrean dan stop player
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.textChannel.send('👋 Everyone left the channel. Disconnecting...');
            queue.delete(guildId);
        }

        // Putus koneksi
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
            duration: songInfo.duration_string
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
                        serverQueue.streamProcess.removeAllListeners('error');
                        serverQueue.streamProcess.kill('SIGKILL');
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
            serverQueue.streamProcess.removeAllListeners('error');
            serverQueue.streamProcess.kill('SIGKILL');
        }

        serverQueue.player.stop();
    }

    // --- STOP COMMAND ---
    else if (command === 'stop') {
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            if (serverQueue.streamProcess) {
                serverQueue.streamProcess.removeAllListeners('error');
                serverQueue.streamProcess.kill('SIGKILL');
            }
            serverQueue.songs = [];
            serverQueue.lastPlayed = null;
            serverQueue.player.stop();
            message.reply('Stopped.');
        }
    }

    // --- LEAVE COMMAND ---
    else if (command === 'leave') {
        const connection = getVoiceConnection(guildId);
        const serverQueue = queue.get(guildId);

        if (serverQueue) {
            if (serverQueue.streamProcess) {
                serverQueue.streamProcess.removeAllListeners('error');
                serverQueue.streamProcess.kill('SIGKILL');
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
            // .setDescription('San\'sMusic')
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