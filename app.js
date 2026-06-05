const STORAGE_KEY = "green-texas-scoreboard-state";
const isControlPage = document.body.dataset.page === "control";
const isDisplayPage = document.body.dataset.page === "display";
const isRemote = location.protocol === "http:" || location.protocol === "https:";

const blindStructure = [
  { smallBlind: 10, bigBlind: 20 },
  { smallBlind: 20, bigBlind: 40 },
  { smallBlind: 50, bigBlind: 100 },
  { smallBlind: 100, bigBlind: 200 },
  { smallBlind: 200, bigBlind: 400 },
  { smallBlind: 300, bigBlind: 600 },
  { smallBlind: 400, bigBlind: 800 },
  { smallBlind: 500, bigBlind: 1000 },
  { smallBlind: 700, bigBlind: 1400 },
  { smallBlind: 1000, bigBlind: 2000 },
  { smallBlind: 2000, bigBlind: 4000 },
  { smallBlind: 3000, bigBlind: 6000 },
];

const defaults = {
  running: false,
  level: 1,
  levelMinutes: 25,
  entryMinutes: 58,
  breakMinutes: 25,
  levelRemaining: 25 * 60,
  entryRemaining: 58 * 60,
  breakRemaining: 25 * 60,
  players: 9,
  playerMax: 9,
  prizePlayers: 3,
  handCount: 9,
  buyInChips: 3000,
  totalChips: 9 * 3000,
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  nextSmallBlind: 20,
  nextBigBlind: 40,
  nextAnte: 0,
};

const inputMap = {
  level: "levelInput",
  levelMinutes: "levelMinutesInput",
  entryMinutes: "entryMinutesInput",
  breakMinutes: "breakMinutesInput",
  players: "playersInput",
  playerMax: "playerMaxInput",
  prizePlayers: "prizeInput",
  handCount: "handCountInput",
  buyInChips: "buyInChipsInput",
};

let state = { ...defaults };
let lastLocalTick = Date.now();
let connected = !isRemote;
let isEditing = false;
let knownLevel = null;
let knownPlayers = null;
let audioContext = null;
let speechQueue = [];
let isSpeaking = false;
let soundGate = null;
let audioPrimed = false;

const el = {
  scoreboard: byId("scoreboard"),
  connectionStatus: byId("connectionStatus"),
  toggleRun: byId("toggleRun"),
  resetLevel: byId("resetLevel"),
  nextLevel: byId("nextLevel"),
  playerMinus: byId("playerMinus"),
  playerPlus: byId("playerPlus"),
  handMinus: byId("handMinus"),
  handPlus: byId("handPlus"),
  soundTest: byId("soundTest"),
  levelValue: byId("levelValue"),
  levelMinutesValue: byId("levelMinutesValue"),
  mainClock: byId("mainClock"),
  playerValue: byId("playerValue"),
  playerMaxValue: byId("playerMaxValue"),
  prizeValue: byId("prizeValue"),
  handCountValue: byId("handCountValue"),
  buyInChipsValue: byId("buyInChipsValue"),
  blindsValue: byId("blindsValue"),
  anteValue: byId("anteValue"),
  nextLevelValue: byId("nextLevelValue"),
  wallClock: byId("wallClock"),
  entryClock: byId("entryClock"),
  breakClock: byId("breakClock"),
  avgChipsValue: byId("avgChipsValue"),
  totalChipsValue: byId("totalChipsValue"),
  inputs: Object.fromEntries(
    Object.entries(inputMap).map(([key, id]) => [key, byId(id)]).filter(([, input]) => input),
  ),
};

function byId(id) {
  return document.getElementById(id);
}

function blindForLevel(level) {
  const index = Math.max(0, Number(level || 1) - 1) % blindStructure.length;
  const blind = blindStructure[index];
  const ante = Number(level) >= 5 ? blind.bigBlind : 0;
  return { ...blind, ante };
}

function blindPatchForLevel(level) {
  const current = blindForLevel(level);
  const next = blindForLevel(Number(level || 1) + 1);
  return {
    smallBlind: current.smallBlind,
    bigBlind: current.bigBlind,
    ante: current.ante,
    nextSmallBlind: next.smallBlind,
    nextBigBlind: next.bigBlind,
    nextAnte: next.ante,
  };
}

function normalizeState(nextState) {
  const merged = { ...defaults, ...nextState };
  merged.level = Math.max(1, Math.floor(Number(merged.level) || 1));
  merged.levelMinutes = Math.max(1, Math.floor(Number(merged.levelMinutes) || defaults.levelMinutes));
  merged.players = Math.max(0, Math.floor(Number(merged.players) || 0));
  merged.playerMax = Math.max(1, Math.floor(Number(merged.playerMax) || 1));
  merged.prizePlayers = Math.max(0, Math.floor(Number(merged.prizePlayers) || 0));
  merged.handCount = Math.max(0, Math.floor(Number(merged.handCount) || 0));
  merged.buyInChips = Math.max(0, Math.floor(Number(merged.buyInChips) || 0));
  merged.handCount = Math.max(merged.handCount, merged.players);
  merged.totalChips = merged.handCount * merged.buyInChips;
  return { ...merged, ...blindPatchForLevel(merged.level) };
}

function loadLocalState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return normalizeState(defaults);
  }
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function pad(value) {
  return String(Math.max(0, value)).padStart(2, "0");
}

function formatMainClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatHourClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatWallClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatNextLevel() {
  const base = `${state.nextSmallBlind}/${state.nextBigBlind}`;
  return state.nextAnte > 0 ? `${base}[${state.nextAnte}]` : base;
}

function asNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function setConnectionStatus() {
  if (!el.connectionStatus) {
    return;
  }

  if (!isRemote) {
    el.connectionStatus.textContent = "单机模式";
    el.connectionStatus.classList.remove("offline");
    return;
  }

  el.connectionStatus.textContent = connected ? "已连接实时大屏" : "连接中断，正在重连";
  el.connectionStatus.classList.toggle("offline", !connected);
}

function syncInputs() {
  if (!isControlPage || isEditing) {
    return;
  }

  Object.entries(el.inputs).forEach(([key, input]) => {
    input.value = state[key] ?? "";
  });
}

function unlockAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      audioPrimed = true;
      updateSoundGate();
      return null;
    }
    audioContext ||= new AudioContextClass();
    audioContext.resume?.();
    audioPrimed = true;
    updateSoundGate();
    return audioContext;
  } catch {
    return null;
  }
}

function playChime() {
  if (document.hidden) {
    return;
  }

  const context = unlockAudio();
  if (!context) {
    return;
  }

  const now = context.currentTime;
  [660, 880, 1100].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, now + index * 0.16);
    gain.gain.setValueAtTime(0.0001, now + index * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.26, now + index * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now + index * 0.16);
    oscillator.stop(now + index * 0.16 + 0.15);
  });
}

function speak(text) {
  unlockAudio();

  if (document.hidden) {
    return;
  }

  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    playChime();
    return;
  }

  speechQueue.push(text);
  drainSpeechQueue();
}

function drainSpeechQueue() {
  if (isSpeaking || speechQueue.length === 0) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(speechQueue.shift());
  utterance.lang = "zh-CN";
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = () => {
    isSpeaking = false;
    drainSpeechQueue();
  };
  utterance.onerror = () => {
    isSpeaking = false;
    drainSpeechQueue();
  };

  isSpeaking = true;
  window.speechSynthesis.speak(utterance);
}

function cancelSpeech() {
  speechQueue = [];
  isSpeaking = false;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // Some embedded browsers expose a partial speech API.
  }
}

function updateSoundGate() {
  if (!soundGate) {
    return;
  }

  soundGate.classList.toggle("hidden", audioPrimed);
}

function setupDisplaySoundGate() {
  if (!isDisplayPage || soundGate) {
    return;
  }

  soundGate = document.createElement("button");
  soundGate.className = "sound-gate";
  soundGate.type = "button";
  soundGate.textContent = "开启播报";
  soundGate.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    unlockAudio();
    playChime();
  });
  document.body.append(soundGate);

  document.addEventListener(
    "pointerdown",
    () => {
      unlockAudio();
    },
    { once: true },
  );
  document.addEventListener(
    "keydown",
    () => {
      unlockAudio();
    },
    { once: true },
  );

  updateSoundGate();
}

function formatSpeechNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function buildLevelAnnouncement(targetLevel) {
  const blind = blindForLevel(targetLevel);
  const parts = [
    `下个级别第${targetLevel}级别`,
    `小盲${formatSpeechNumber(blind.smallBlind)}`,
    `大盲${formatSpeechNumber(blind.bigBlind)}`,
  ];

  parts.push(blind.ante > 0 ? `预置分${formatSpeechNumber(blind.ante)}` : "无预置分");
  return parts.join("，");
}

function playLevelSound(targetLevel = state.level + 1) {
  playChime();
  window.setTimeout(() => speak(buildLevelAnnouncement(targetLevel)), 720);
}

function playFinalTableSound() {
  playChime();
  window.setTimeout(() => speak("恭喜进入决赛圈"), 720);
}

function watchLevelSound() {
  if (knownLevel === null) {
    knownLevel = state.level;
    return;
  }

  if (state.level > knownLevel) {
    if (isDisplayPage) {
      playLevelSound(state.level);
    }
  }

  knownLevel = state.level;
}

function watchPlayerAnnouncements() {
  if (knownPlayers === null) {
    knownPlayers = state.players;
    return;
  }

  if (knownPlayers > 2 && state.players === 2) {
    if (isDisplayPage) {
      playFinalTableSound();
    }
  }

  knownPlayers = state.players;
}

function render() {
  state = normalizeState(state);
  const avgChips = state.players > 0 ? Math.round(state.totalChips / state.players) : 0;

  setText(el.levelValue, state.level);
  setText(el.levelMinutesValue, state.levelMinutes);
  setText(el.mainClock, formatMainClock(state.levelRemaining));
  setText(el.playerValue, state.players);
  setText(el.playerMaxValue, state.playerMax);
  setText(el.prizeValue, state.prizePlayers);
  setText(el.handCountValue, state.handCount);
  setText(el.buyInChipsValue, state.buyInChips);
  setText(el.blindsValue, `${state.smallBlind}/${state.bigBlind}`);
  setText(el.anteValue, state.ante);
  setText(el.nextLevelValue, formatNextLevel());
  setText(el.wallClock, formatWallClock(new Date()));
  setText(el.entryClock, formatHourClock(state.entryRemaining));
  setText(el.breakClock, formatHourClock(state.breakRemaining));
  setText(el.avgChipsValue, avgChips);
  setText(el.totalChipsValue, state.totalChips);
  setText(el.toggleRun, state.running ? "暂停" : "开始");

  watchLevelSound();
  watchPlayerAnnouncements();
  syncInputs();
  setConnectionStatus();
}

async function sendState(nextState = state) {
  const payload = normalizeState(nextState);

  if (!isRemote) {
    state = payload;
    saveLocalState();
    render();
    return;
  }

  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    state = normalizeState(data);
    connected = true;
    render();
  } catch {
    connected = false;
    render();
  }
}

async function fetchState() {
  if (!isRemote) {
    state = loadLocalState();
    render();
    return;
  }

  try {
    const response = await fetch("/api/state");
    const data = await response.json();
    state = normalizeState(data);
    connected = true;
    render();
  } catch {
    connected = false;
    render();
  }
}

function updateState(patch, shouldSend = true) {
  state = normalizeState({ ...state, ...patch });
  if (!isRemote) {
    saveLocalState();
  }
  render();

  if (shouldSend) {
    sendState();
  }
}

function updateFromInput(key, value) {
  const numericValue = Math.max(0, asNumber(value, defaults[key] ?? 0));
  const patch = { [key]: numericValue };

  if (key === "level") {
    patch.levelRemaining = state.levelMinutes * 60;
  }

  if (key === "levelMinutes") {
    patch.levelRemaining = numericValue * 60;
  }

  if (key === "entryMinutes") {
    patch.entryRemaining = numericValue * 60;
  }

  if (key === "breakMinutes") {
    patch.breakRemaining = numericValue * 60;
  }

  updateState(patch);
}

function bindControlEvents() {
  if (!isControlPage) {
    return;
  }

  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("keydown", unlockAudio, { once: true });

  el.toggleRun?.addEventListener("click", () => {
    unlockAudio();
    lastLocalTick = Date.now();
    updateState({ running: !state.running });
  });

  el.resetLevel?.addEventListener("click", () => {
    unlockAudio();
    lastLocalTick = Date.now();
    updateState({
      level: 1,
      levelRemaining: state.levelMinutes * 60,
      entryRemaining: state.entryMinutes * 60,
      breakRemaining: state.breakMinutes * 60,
    });
  });

  el.nextLevel?.addEventListener("click", () => {
    unlockAudio();
    const nextLevel = state.level + 1;
    lastLocalTick = Date.now();
    updateState({
      level: nextLevel,
      levelRemaining: state.levelMinutes * 60,
    });
  });

  el.playerMinus?.addEventListener("click", () => {
    updateState({ players: Math.max(0, state.players - 1) });
  });

  el.playerPlus?.addEventListener("click", () => {
    updateState({ players: state.players + 1 });
  });

  el.handMinus?.addEventListener("click", () => {
    updateState({ handCount: Math.max(0, state.handCount - 1) });
  });

  el.handPlus?.addEventListener("click", () => {
    updateState({ handCount: state.handCount + 1 });
  });

  el.soundTest?.addEventListener("click", () => {
    playLevelSound();
  });

  Object.entries(el.inputs).forEach(([key, input]) => {
    input.addEventListener("focus", () => {
      isEditing = true;
    });
    input.addEventListener("blur", () => {
      isEditing = false;
      syncInputs();
    });
    input.addEventListener("input", () => updateFromInput(key, input.value));
  });
}

function bindDisplayEvents() {
  if (isControlPage) {
    return;
  }

  setupDisplaySoundGate();

  document.addEventListener("dblclick", async () => {
    if (!el.scoreboard || document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await el.scoreboard.requestFullscreen();
  });

  fitDisplayBoard();
  window.addEventListener("resize", fitDisplayBoard);
  window.addEventListener("orientationchange", () => setTimeout(fitDisplayBoard, 260));
}

function fitDisplayBoard() {
  if (!isDisplayPage || !el.scoreboard) {
    return;
  }

  const shouldScale = window.innerWidth < 980 || window.innerHeight < 560;
  if (!shouldScale) {
    document.body.classList.remove("scaled-display");
    document.body.style.removeProperty("--display-scale");
    return;
  }

  const scale = Math.min((window.innerWidth - 12) / 1280, (window.innerHeight - 12) / 720, 1);
  document.body.classList.add("scaled-display");
  document.body.style.setProperty("--display-scale", String(Math.max(0.1, scale)));
}

function connectEvents() {
  if (!isRemote || typeof EventSource === "undefined") {
    return;
  }

  const events = new EventSource("/api/events");

  events.onopen = () => {
    connected = true;
    render();
  };

  events.onmessage = (event) => {
    connected = true;
    state = normalizeState(JSON.parse(event.data));
    render();
  };

  events.onerror = () => {
    connected = false;
    render();
  };
}

function localTick() {
  const now = Date.now();
  const elapsed = Math.floor((now - lastLocalTick) / 1000);

  if (elapsed > 0) {
    lastLocalTick = now;

    if (!isRemote && state.running) {
      let level = state.level;
      let levelRemaining = state.levelRemaining - elapsed;
      while (levelRemaining <= 0) {
        level += 1;
        levelRemaining += state.levelMinutes * 60;
      }
      updateState(
        {
          level,
          levelRemaining,
          entryRemaining: Math.max(0, state.entryRemaining - elapsed),
          breakRemaining: Math.max(0, state.breakRemaining - elapsed),
        },
        false,
      );
    }
  }

  render();
}

async function start() {
  state = loadLocalState();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelSpeech();
    }
  });
  window.addEventListener("pagehide", cancelSpeech);
  window.addEventListener("beforeunload", cancelSpeech);
  bindControlEvents();
  bindDisplayEvents();
  await fetchState();
  connectEvents();
  setInterval(localTick, 250);
  setInterval(() => {
    if (isRemote && !connected) {
      fetchState();
    }
  }, 2000);
}

start();
