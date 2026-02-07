function formatTime(sec) {
    if (!sec || isNaN(sec)) return 'Live';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function createProgressBar(current, total, size = 20) {
    if (!total || isNaN(total)) return '🔴 LIVE';

    const percent = Math.min(current / total, 1);
    const filled = Math.round(size * percent);
    const empty = size - filled;

    return `▶ ${'█'.repeat(filled)}${'─'.repeat(empty)} ${Math.round(percent * 100)}%`;
}

module.exports = { formatTime, createProgressBar };
