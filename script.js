const API_BASE_URL = 'https://radio.beeptunes.com/api/nowplaying';
const TIME_LAG_BUFFER = 40; // Time buffer in seconds to compensate for stream latency

// --- DOM Elements ---
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const albumArt = document.getElementById('album-art');
const songTitle = document.getElementById('song-title');
const artistName = document.getElementById('artist-name');
const stationNameEl = document.getElementById('station-name');
const stationsContainer = document.getElementById('stations-container');
const loadingSpinner = document.getElementById('loading-spinner');
const stationsPlaceholder = document.getElementById('stations-placeholder');

// --- Time and Visualizer Elements ---
const elapsedTimeEl = document.getElementById('elapsed-time');
const durationTimeEl = document.getElementById('duration-time');
const progressBarEl = document.getElementById('progress-bar');
const visualizerCanvas = document.getElementById('audio-visualizer');
const canvasCtx = visualizerCanvas.getContext('2d');

// --- Global Playback Variables ---
let availableStations = [];
let audioSource = null;
let isPlaying = false;
let currentStationShortcode = null;
let currentStreamUrl = null;
let intervalId = null; // For progress bar update

let currentDuration = 0;
let currentStartTime = 0; // This will now hold the lag-adjusted start time

// --- Visualizer Variables (Web Audio API) ---
let animationFrameId = null;
let audioContext = null;
let analyser = null;
let sourceNode = null;

// --- Waveform Sampling Control ---
let peakSamplingIntervalId = null;
const WAVEFORM_UPDATE_INTERVAL = 15; // 15ms sampling interval for high reactivity
let waveformHistory = []; // Array to hold historical bar heights

// --- Waveform Drawing Setup ---
const VIS_W = visualizerCanvas.width;
const VIS_H = visualizerCanvas.height;
const CENTER_Y = VIS_H / 2;

// Styles and Colors
const BAR_COLOR = '#a7f3d0'; // Neon green color
const LINE_COLOR_CENTER = '#a7f3d0'; // Set to be the exact same as BAR_COLOR (user request)
const BACKGROUND_COLOR = '#111827'; // Internal Canvas background color

// Bar Geometry
const BAR_WIDTH = 2; // Width of each bar
const BAR_SPACING = 1; // Spacing between bars
const STEP = BAR_WIDTH + BAR_SPACING;
const TOTAL_BARS = Math.floor(VIS_W / STEP); // Total drawable bars
let dataArray = null; // Time domain data array

const STATION_NAME_MAP = {
    "Radio Beeptunes": "رادیو بیپ تونز",
    "Rangarang": "رنگارنگ",
    "Aramesh": "آرامش",
    "Sarkhoshan-e mast": "سرخوشان مست",
    "Owj": "اوج",
    "Sarzamin": "سرزمین",
    "Avang": "آونگ",
    "Harmony": "هارمونی"
};

// --- Helper Functions ---

/**
 * Converts seconds to MM:SS format.
 * @param {number} totalSeconds - Total seconds.
 * @returns {string} Formatted time string.
 */
function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Updates the progress bar and time display.
 * @param {number} currentTime - Current elapsed time.
 */
function updateProgress(currentTime) {
    const duration = currentDuration;
    if (duration > 0) {
        const progressTime = Math.min(currentTime, duration);
        const progressPercentage = (progressTime / duration) * 100;

        elapsedTimeEl.textContent = formatTime(progressTime);
        durationTimeEl.textContent = formatTime(duration);
        progressBarEl.querySelector('div').style.width = `${progressPercentage}%`;
    } else {
        // Default display when no valid track info is available
        elapsedTimeEl.textContent = '0:00';
        durationTimeEl.textContent = '0:00';
        progressBarEl.querySelector('div').style.width = '0%';
    }
}

/**
 * Manages the progress timer loop.
 * StartTime is expected to be the lag-adjusted Unix timestamp in seconds.
 */
function startProgressTimer(lagAdjustedStartTime, duration) {
    if (intervalId) {
        clearInterval(intervalId);
    }

    currentStartTime = lagAdjustedStartTime; // Lag already applied in updateNowPlayingInfo
    currentDuration = duration;

    // Initial update based on API time data
    const initialElapsedApiTime = Math.floor((Date.now() / 1000) - currentStartTime);
    updateProgress(initialElapsedApiTime);

    const checkInterval = 1000; // Check every 1 second

    intervalId = setInterval(() => {
        // Calculate elapsed time from the lag-adjusted start time
        const elapsedApiTime = Math.floor((Date.now() / 1000) - currentStartTime);

        updateProgress(elapsedApiTime);

        // Fetch new info if song duration exceeded
        if (elapsedApiTime >= currentDuration) {
            // 5 seconds after song finishes, check for new info
            if (elapsedApiTime > currentDuration + 5) {
                fetchNowPlayingInfo();
            }
        }

    }, checkInterval);
}

/**
 * Stops the progress timer.
 */
function stopProgressTimer() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

/**
 * Sets up the Audio Context and Analyser node.
 */
function setupAudioContextAndAnalyser() {
    // IMPORTANT FIX: Only create AudioContext when a user gesture is detected (in playAudio)
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (!analyser) {
        analyser = audioContext.createAnalyser();
        // FFT size set to 256 for time domain data
        analyser.fftSize = 256;
        dataArray = new Uint8Array(analyser.fftSize);
    }
}

/**
 * Starts 15ms peak sampling for the waveform history.
 */
function startPeakSampling() {
    if (peakSamplingIntervalId) clearInterval(peakSamplingIntervalId);

    // Initial fill history with zeros
    waveformHistory = Array(TOTAL_BARS).fill(0);

    peakSamplingIntervalId = setInterval(() => {
        if (!analyser || !dataArray || !isPlaying || audioContext.state === 'suspended') {
            stopPeakSampling();
            return;
        }

        // Get time domain data (amplitude)
        analyser.getByteTimeDomainData(dataArray);

        let maxAmplitude = 0;

        // Find the highest peak in the buffer
        for (let j = 0; j < dataArray.length; j++) {
            // Normalize data to -128 to 127 range and take absolute value
            const amplitudeSample = Math.abs(dataArray[j] - 128);
            if (amplitudeSample > maxAmplitude) {
                maxAmplitude = amplitudeSample;
            }
        }

        // Normalize the peak amplitude (maxAmplitude is 0-127)
        const normalizedAmplitude = maxAmplitude / 128;

        // Calculate half bar height (0.45 for margin)
        const halfBarHeight = normalizedAmplitude * (VIS_H * 0.45);

        // Shift array and add new bar (creates scrolling effect)
        if (waveformHistory.length >= TOTAL_BARS) {
            waveformHistory.shift();
        }
        waveformHistory.push(halfBarHeight);

    }, WAVEFORM_UPDATE_INTERVAL); // 15ms
}

/**
 * Stops peak sampling.
 */
function stopPeakSampling() {
    if (peakSamplingIntervalId) {
        clearInterval(peakSamplingIntervalId);
        peakSamplingIntervalId = null;
    }
}

/**
 * Draws the center dashed line on the canvas.
 * This function is used for the initial/paused state.
 */
function drawCenterLine() {
    // Clear canvas and draw dark background
    canvasCtx.fillStyle = BACKGROUND_COLOR;
    canvasCtx.fillRect(0, 0, VIS_W, VIS_H);

    // Draw the thin center dashed line
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = LINE_COLOR_CENTER;
    canvasCtx.lineWidth = 0.5;

    // Simulate dashed line
    for (let dashX = 0; dashX < VIS_W; dashX += 4) {
        canvasCtx.moveTo(dashX, CENTER_Y);
        canvasCtx.lineTo(dashX + 2, CENTER_Y);
    }
    canvasCtx.stroke();
}

/**
 * Main visualizer drawing function (runs at 60 FPS for smooth scrolling).
 */
function drawVisualizer() {
    // Request next animation frame
    animationFrameId = requestAnimationFrame(drawVisualizer);

    if (!isPlaying) {
        // Exit loop if playback is stopped
        cancelAnimationFrame(animationFrameId);
        return;
    }

    // Clear canvas and draw dark background
    canvasCtx.fillStyle = BACKGROUND_COLOR;
    canvasCtx.fillRect(0, 0, VIS_W, VIS_H);

    // Set style for drawing bars
    canvasCtx.strokeStyle = BAR_COLOR;
    canvasCtx.lineWidth = BAR_WIDTH;

    let x = 0; // Starting horizontal position

    // Draw based on history array
    for (let i = 0; i < waveformHistory.length; i++) {
        const halfBarHeight = waveformHistory[i];

        // Start drawing the bar
        canvasCtx.beginPath();

        const startY = CENTER_Y - halfBarHeight;
        const endY = CENTER_Y + halfBarHeight;

        canvasCtx.moveTo(x, startY);
        canvasCtx.lineTo(x, endY);

        canvasCtx.stroke();

        x += STEP;
    }

    // Always draw the center line over the bars for visual anchor
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = LINE_COLOR_CENTER;
    canvasCtx.lineWidth = 0.5;

    for (let dashX = 0; dashX < VIS_W; dashX += 4) {
        canvasCtx.moveTo(dashX, CENTER_Y);
        canvasCtx.lineTo(dashX + 2, CENTER_Y);
    }
    canvasCtx.stroke();
}

/**
 * Updates the Media Session metadata and action handlers for OS-level control.
 * @param {object} song - The song object (title, artist, art).
 * @param {object} station - The station object (name).
 */
function updateMediaSession(song, station) {
    if ('mediaSession' in navigator) {
        const artworkUrl = song.art || `https://placehold.co/512/EEE/31343C?font=Vazirmatn&text=${station.name.replace(/\s/g, '+') || 'رادیو'}`;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title || 'عنوان نامشخص',
            artist: song.artist || station.name,
            album: station.name || 'رادیو بیپ تونز',
            artwork: [
                { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
            ]
        });

        // Set OS media controls (Play/Pause)
        navigator.mediaSession.setActionHandler('play', () => {
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
            if (!isPlaying) togglePlayPause();
        });
        navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) togglePlayPause(); });

        // Disable seek/skip handlers as this is a radio stream
        navigator.mediaSession.setActionHandler('seekto', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
    }
}

/**
 * Clears the Media Session metadata.
 */
function clearMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
    }
}

/**
 * Fetches data from the API.
 */
async function fetchData() {
    try {
        const response = await fetch(API_BASE_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching API data:", error);
        return null;
    }
}

/**
 * Extracts available stations from the API response.
 */
function extractStations(allStationsData) {
    return allStationsData.map(stationData => {
        const originalName = stationData.station.name;
        const persianName = STATION_NAME_MAP[originalName] || originalName;

        // Prioritize the direct listen_url, otherwise use the default mount URL
        const listenUrl = stationData.station.listen_url || (stationData.station.mounts.find(m => m.is_default)?.url);

        return {
            name: persianName,
            originalName: originalName,
            shortcode: stationData.station.shortcode,
            url: listenUrl
        };
    }).filter(s => s.url);
}

/**
 * Updates the now playing info on the UI by determining the correct track 
 * based on current time and stream latency buffer.
 */
function updateNowPlayingInfo(data) {
    if (!data || !data.now_playing || !data.station) {
        // Fallback text in Persian
        songTitle.textContent = 'اطلاعات در دسترس نیست';
        artistName.textContent = 'لطفا ایستگاه را انتخاب کنید';
        stationNameEl.textContent = data?.station?.name || 'Beeptunes Radio';
        albumArt.src = `https://placehold.co/512/EEE/31343C?font=Vazirmatn&text=${(data?.station?.name || 'رادیو').replace(/\s/g, '+')}`;
        stopProgressTimer();
        clearMediaSession();
        return;
    }

    const currentTimestampSec = Date.now() / 1000;
    let trackData = data.now_playing;

    // Calculate corrected start and end times for the 'now_playing' item
    const nowStartTime = trackData.played_at + TIME_LAG_BUFFER; // Seconds
    const nowEndTime = nowStartTime + trackData.duration; // Seconds

    // --- Case 2: Previous Song (Date.now() < nowStartTime) ---
    if (currentTimestampSec < nowStartTime) {
        const lastHistory = data.song_history && data.song_history.length > 0 ? data.song_history[0] : null;
        if (lastHistory) {
            trackData = lastHistory;
            // For history items, we need to re-calculate their lag-adjusted played_at
            const historyStartTime = trackData.played_at + TIME_LAG_BUFFER;
            const historyEndTime = historyStartTime + trackData.duration;

            // If the history item is too old, still fall back to the now_playing item
            if (currentTimestampSec > historyEndTime) {
                trackData = data.now_playing;
            } else {
            }
        } else {
            console.error("API timing mismatch: current time is before now_playing start, but song_history is empty. Falling back to now_playing.");
        }
    }
    // --- Case 3: Next Song (Date.now() > nowEndTime) ---
    else if (currentTimestampSec >= nowEndTime && data.playing_next) {
        trackData = data.playing_next;
    }

    // Determine playedAt (lag-adjusted) and duration for the selected track
    // The correct played_at is now the only one stored in the final trackData
    const playedAt = trackData.played_at + TIME_LAG_BUFFER;
    const duration = trackData.duration;

    const song = trackData.song;
    const station = data.station;

    // Update song title, artist, album art
    songTitle.textContent = song.title || 'بدون عنوان';
    artistName.textContent = song.artist || 'هنرمند ناشناس';
    albumArt.src = song.art || `https://placehold.co/512/EEE/31343C?font=Vazirmatn&text=${station.name.replace(/\s/g, '+')}`;
    stationNameEl.textContent = STATION_NAME_MAP[station.name] || station.name;

    // Update Media Session for OS control
    updateMediaSession(song, station);

    // Start progress timer with the correct (lag-adjusted) playedAt timestamp
    startProgressTimer(playedAt, duration);
}

/**
 * Fetches 'Now Playing' info for the current station.
 */
async function fetchNowPlayingInfo() {
    const allStationsData = await fetchData();
    if (allStationsData && currentStationShortcode) {
        const stationData = allStationsData.find(d => d.station.shortcode === currentStationShortcode);
        if (stationData) {
            updateNowPlayingInfo(stationData);
        }
    }
}

/**
 * Updates station button styles.
 */
function updateStationButtons() {
    document.querySelectorAll('.station-btn').forEach(btn => {
        btn.classList.remove('active', 'bg-gray-600', 'text-white', 'border-[#58a6ff]');
        btn.classList.add('bg-gray-700', 'text-gray-300', 'border-transparent');

        if (btn.id === `station-btn-${currentStationShortcode}`) {
            btn.classList.add('active', 'bg-gray-600', 'text-white', 'border-[#58a6ff]');
            btn.classList.remove('bg-gray-700', 'text-gray-300');
        }
    });
}

/**
 * Switches the radio station.
 */
function switchStation(shortcode) {
    const newStation = availableStations.find(s => s.shortcode === shortcode);
    if (!newStation) return;

    // Stop audio if playing or station is changing
    const wasPlaying = isPlaying;
    if (isPlaying || currentStationShortcode !== shortcode) {
        stopAudio();
    }

    currentStationShortcode = shortcode;
    currentStreamUrl = newStation.url;

    // Update playing info (will fetch the latest API data and adjust time)
    fetchNowPlayingInfo();

    // Activate new station button
    updateStationButtons();

    // If it was playing before the switch, resume playback
    if (wasPlaying) {
        // Must wait for currentStreamUrl to be set by fetchNowPlayingInfo (though it is set above)
        // The main goal is to restart playback if the user clicked another station while playing
        playAudio();
    }
}

/**
 * Toggles play/pause state.
 */
function togglePlayPause() {
    if (isPlaying) {
        stopAudio();
    } else {
        // If no station is selected, select the first one
        if (!currentStationShortcode && availableStations.length > 0) {
            const firstStation = availableStations[0];
            currentStationShortcode = firstStation.shortcode;
            currentStreamUrl = firstStation.url;
            fetchNowPlayingInfo(); // Fetch and update info for the selected station
            updateStationButtons();
        }
        if (currentStreamUrl) {
            playAudio();
        }
    }
}

/**
 * Starts audio stream playback and connects Web Audio API.
 */
async function playAudio() {
    if (!currentStreamUrl) return;

    loadingSpinner.style.display = 'block';

    // 1. Setup Audio Context and Analyser (must happen inside user gesture)
    setupAudioContextAndAnalyser();

    // Create Audio object and Source Node if not already created
    if (!audioSource) {
        audioSource = new Audio();
        audioSource.crossOrigin = 'anonymous'; // Required for audio analysis
        audioSource.preload = 'none';

        // Create sourceNode and connect to graph only once
        sourceNode = audioContext.createMediaElementSource(audioSource);
        sourceNode.connect(analyser); // Connect to Analyser
        analyser.connect(audioContext.destination); // Connect Analyser to output

        audioSource.addEventListener('canplay', () => {
            loadingSpinner.style.display = 'none';
        });

        audioSource.addEventListener('error', (e) => {
            console.error("Audio error:", e);
            songTitle.textContent = 'خطا در پخش استریم'; // Persian error message
            loadingSpinner.style.display = 'none';
            stopAudio();
        });
    }

    // Set stream URL and start playback
    audioSource.src = currentStreamUrl;
    audioSource.load(); // Ensure the element reloads the new stream

    // Resume AudioContext if suspended (browser restriction)
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        } catch (e) {
            console.error("AudioContext resume failed:", e);
            loadingSpinner.style.display = 'none';
            songTitle.textContent = 'خطا در راه‌اندازی صدا';
            return; // Stop if context can't resume
        }
    }

    try {
        await audioSource.play();
        isPlaying = true;

        // Update icon
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';

        // Start peak sampling
        startPeakSampling();

        // Start visualizer drawing loop
        drawVisualizer();

    } catch (error) {
        console.error("Error attempting to play audio:", error);
        songTitle.textContent = 'خطا در پخش (نیاز به تعامل کاربر)';
        loadingSpinner.style.display = 'none';
        isPlaying = false;
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
    }
}

/**
 * Stops audio stream playback.
 */
function stopAudio() {
    if (audioSource) {
        audioSource.pause();
    }
    isPlaying = false;

    // Clear Media Session info on stop
    clearMediaSession();

    // Stop peak sampling
    stopPeakSampling();

    // Stop visualizer animation
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    // Redraw canvas with only the center line (paused state)
    drawCenterLine();

    // Stop progress timer
    stopProgressTimer();

    // Update icon
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    loadingSpinner.style.display = 'none';
}

/**
 * Creates station buttons based on the available list.
 */
function createStationButtons() {
    stationsPlaceholder.style.display = 'none';
    stationsContainer.innerHTML = '';

    availableStations.forEach(station => {
        const button = document.createElement('button');
        button.id = `station-btn-${station.shortcode}`;
        button.textContent = station.name;
        // Tailwind classes for styling
        button.className = 'station-btn bg-gray-700 text-gray-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-600 transition duration-150 ease-in-out whitespace-nowrap border border-transparent';
        button.addEventListener('click', () => switchStation(station.shortcode));

        stationsContainer.appendChild(button);
    });

    if (availableStations.length > 0) {
        // Automatically select the first station, but don't start playing
        const firstStation = availableStations[0];
        currentStationShortcode = firstStation.shortcode;
        currentStreamUrl = firstStation.url;
        // Initial fetch for the first station
        fetchNowPlayingInfo();
        updateStationButtons();
    } else {
        stationsPlaceholder.style.display = 'block';
        stationsPlaceholder.textContent = 'هیچ ایستگاهی پیدا نشد.'; // Persian text
    }
}

// --- Event Listeners ---
playPauseBtn.addEventListener('click', togglePlayPause);

// --- Main Initialization Function ---
async function init() {
    // Open album art in new tab on click
    albumArt.addEventListener("click", () => { let e = albumArt.src; e && !e.includes("placehold.co") && window.open(e, "_blank") });

    stationsPlaceholder.style.display = 'block';
    stationsPlaceholder.textContent = 'در حال بارگذاری ایستگاه‌ها...';

    // Initial draw of the center line (without AudioContext dependency)
    drawCenterLine();

    const allStationsData = await fetchData();

    if (allStationsData && Array.isArray(allStationsData)) {
        availableStations = extractStations(allStationsData);
        createStationButtons();

        // Set up interval for refreshing track info every 10 seconds
        setInterval(fetchNowPlayingInfo, 10000);

    } else {
        songTitle.textContent = 'اتصال به API برقرار نشد.'; // Persian error message
        artistName.textContent = '';
        stationsPlaceholder.textContent = 'خطا در بارگذاری اطلاعات ایستگاه‌ها.'; // Persian error message
    }
}

// Start the app after DOM is fully loaded
init();