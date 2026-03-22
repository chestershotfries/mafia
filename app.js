/* Mafia Randomizer frontend — GitHub Pages + Cloud Function backend */

// Replace with your Cloud Function deployment URL
const SCRIPT_URL = 'https://us-central1-mafia-tracker-310960.cloudfunctions.net/mafia-backend';

const GHOST_NAME = 'Ghost';
const RANDOM_ORG_API_KEY = '93e00e92-f44b-4b59-993a-309ecee52caa';

function isGhostEntry(name) {
	return name === GHOST_NAME || name.startsWith(GHOST_NAME + ' ');
}

function makeGhostNames(count) {
	if (count === 0) return [];
	if (count === 1) return [GHOST_NAME];
	return Array.from({length: count}, (_, i) => `${GHOST_NAME} ${i + 1}`);
}

let randomPool = [];
let poolIndex = 0;

let currentAssignments = null;
let currentFormals = null;
let rollCount = 0;
let knownPlayers = [];
let playerRankMap = new Map();
let nightActions = [];
let vigiHasShot = false;
let dayVotes = {};
let gameMode = 'randomize'; // 'randomize' | 'manual' | 'retroactive' | 'darkstars'
let gameVariant = 'allstars'; // 'allstars' | 'darkstars'
let darkStarsSetup = null; // 1 | 2 | 3
let oneShotTracker = {}; // { roleKey: boolean }
let darkStarsNames = [];
let manualRoleMap = new Map(); // name → 'Mafia'|'Cop'|'Medic'|'Vigi'
let retroRoleMap = new Map();
let manualNames = [];
let retroNames = [];
let manualSkipMatch = new Set();
let retroSkipMatch = new Set();

const ROLE_CYCLE = ['Town', 'Mafia', 'Cop', 'Medic', 'Vigi'];
const ROLE_LIMITS = { Mafia: 3, Cop: 1, Medic: 1, Vigi: 1 };
const ROLE_CSS = { Town: '', Mafia: 'mafia', Cop: 'cop', Medic: 'medic', Vigi: 'vigi' };

// Dark Stars setup definitions
const DARK_STARS_SETUPS = {
	1: {
		name: 'Corrupted Cop',
		mafiaFaction: 'Rolecop',
		townRoles: [
			{ key: 'morticianA', label: 'Mortician A', oneShot: true },
			{ key: 'morticianB', label: 'Mortician B', oneShot: true },
			{ key: 'nerfedMedicA', label: 'Nerfed Medic A' },
			{ key: 'nerfedMedicB', label: 'Nerfed Medic B' },
			{ key: 'vigi', label: 'Vigilante', oneShot: true },
		],
	},
	2: {
		name: 'Corrupted Medic',
		mafiaFaction: 'Roleblock',
		mafiaFactionOneShot: true,
		townRoles: [
			{ key: 'morticianA', label: 'Mortician A', oneShot: true },
			{ key: 'parityCop', label: 'Parity Cop' },
			{ key: 'vigi', label: 'Vigilante', oneShot: true },
		],
	},
	3: {
		name: 'Corrupted Vigilante',
		mafiaFaction: 'Split Vigi',
		mafiaFactionOneShot: true,
		townRoles: [
			{ key: 'morticianA', label: 'Mortician A', oneShot: true },
			{ key: 'parityCop', label: 'Parity Cop' },
			{ key: 'nerfedMedicA', label: 'Nerfed Medic' },
		],
	},
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Toast ---

function showToast(msg, isSuccess) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.toggle('success', !!isSuccess);
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// --- Panel switching ---

function showPanel(id) {
	$$('.panel').forEach((p) => p.classList.add('hidden'));
	$(`#${id}`).classList.remove('hidden');
}

// --- API helper ---

async function api(action, data = {}) {
	const resp = await fetch(SCRIPT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...data }),
	});
	const result = await resp.json();
	if (result.error) {
		throw new Error(result.error);
	}
	return result;
}

// --- Name counter ---

function countNames() {
	const raw = $('#names-input').value;
	let names;
	if (raw.includes(',')) {
		names = raw.split(',').map((n) => n.trim()).filter(Boolean);
	} else {
		names = raw.split('\n').map((n) => n.trim()).filter(Boolean);
	}
	const count = names.length;
	const ghosts = count >= 13 && count <= 15 ? 15 - count : 0;
	const ghostText = count >= 13 && count <= 15
		? ` (${ghosts} ghost${ghosts !== 1 ? 's' : ''} will be added)`
		: '';
	$('#name-counter').textContent = `${count}/15 names${ghostText}`;
	return count;
}

// --- Client-side randomization (ported from engine.py) ---

function validateNames(rawInput) {
	let names;
	if (rawInput.includes(',')) {
		names = rawInput.split(',').map((n) => n.trim()).filter(Boolean);
	} else {
		names = rawInput.split('\n').map((n) => n.trim()).filter(Boolean);
	}

	const seen = new Set();
	const dupes = [];
	for (const n of names) {
		const lower = n.toLowerCase();
		if (seen.has(lower)) dupes.push(n);
		seen.add(lower);
	}
	if (dupes.length) {
		throw new Error(`Duplicate names: ${dupes.join(', ')}`);
	}
	if (names.length < 13 || names.length > 15) {
		throw new Error(`Need 13-15 players, got ${names.length}`);
	}
	return names;
}

function validateDarkStarsNames(rawInput) {
	let names;
	if (rawInput.includes(',')) {
		names = rawInput.split(',').map((n) => n.trim()).filter(Boolean);
	} else {
		names = rawInput.split('\n').map((n) => n.trim()).filter(Boolean);
	}

	const seen = new Set();
	const dupes = [];
	for (const n of names) {
		const lower = n.toLowerCase();
		if (seen.has(lower)) dupes.push(n);
		seen.add(lower);
	}
	if (dupes.length) {
		throw new Error(`Duplicate names: ${dupes.join(', ')}`);
	}
	if (names.length < 15 || names.length > 16) {
		throw new Error(`Dark Stars needs 15-16 players, got ${names.length}`);
	}
	return names;
}

// --- Random number pool (random.org with crypto fallback) ---

async function fillRandomPool(n) {
	try {
		const res = await fetch('https://api.random.org/json-rpc/4/invoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'generateDecimalFractions',
				params: {
					apiKey: RANDOM_ORG_API_KEY,
					n,
					decimalPlaces: 14,
					replacement: true,
				},
				id: 1,
			}),
		});
		const data = await res.json();
		if (data.error) throw new Error(data.error.message);
		randomPool = data.result.random.data;
		poolIndex = 0;
	} catch (e) {
		console.warn('random.org unavailable, falling back to crypto:', e.message);
		randomPool = [];
		poolIndex = 0;
		for (let i = 0; i < n; i++) {
			randomPool.push(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296);
		}
	}
}

function nextRandom() {
	if (poolIndex < randomPool.length) {
		return randomPool[poolIndex++];
	}
	return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function shuffleArray(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function randomize(names) {
	const numGhosts = 15 - names.length;
	const real = shuffleArray([...names]);

	// Zone 1 (positions 1-3): Mafia — always real players
	const mafia = real.slice(0, 3);
	let remaining = real.slice(3);

	// Zone 2 (positions 4-6): Town — 0 or 1 ghost, rest real
	const ghostsInZone2 = Math.min(numGhosts, Math.round(nextRandom()));
	const ghostsInZone3 = numGhosts - ghostsInZone2;

	const zone2RealCount = 3 - ghostsInZone2;
	const zone2Real = remaining.slice(0, zone2RealCount);
	remaining = remaining.slice(zone2RealCount);
	const zone2All = shuffleArray([...zone2Real, ...Array(ghostsInZone2).fill(GHOST_NAME)]);

	// Zone 3 (positions 7-15): Town — remaining real + remaining ghosts
	const zone3 = shuffleArray([...remaining, ...Array(ghostsInZone3).fill(GHOST_NAME)]);

	shuffleArray(mafia);

	const assignments = [];
	mafia.forEach((name, i) => {
		assignments.push({ position: i + 1, name, role: 'Mafia', is_ghost: false });
	});
	zone2All.forEach((name, i) => {
		assignments.push({ position: i + 4, name, role: 'Town', is_ghost: name === GHOST_NAME });
	});
	zone3.forEach((name, i) => {
		assignments.push({ position: i + 7, name, role: 'Town', is_ghost: name === GHOST_NAME });
	});

	return assignments;
}

function buildAssignments(names, roleMap) {
	const mafiaNames = names.filter((n) => roleMap.get(n) === 'Mafia');
	const cop = names.find((n) => roleMap.get(n) === 'Cop');
	const medic = names.find((n) => roleMap.get(n) === 'Medic');
	const vigi = names.find((n) => roleMap.get(n) === 'Vigi');
	const regularTown = names.filter((n) => !roleMap.has(n) || roleMap.get(n) === 'Town');

	const assignments = [];
	// Positions 1-3: Mafia
	mafiaNames.forEach((name, i) => {
		assignments.push({ position: i + 1, name, role: 'Mafia', is_ghost: false });
	});
	// Position 4: Cop, 5: Medic, 6: Vigi (or ghost if unassigned)
	[cop, medic, vigi].forEach((name, i) => {
		if (name) {
			const ghost = isGhostEntry(name);
			assignments.push({ position: i + 4, name: ghost ? GHOST_NAME : name, role: 'Town', is_ghost: ghost });
		} else {
			assignments.push({ position: i + 4, name: GHOST_NAME, role: 'Town', is_ghost: true });
		}
	});
	// Positions 7+: regular town
	regularTown.forEach((name, i) => {
		const ghost = isGhostEntry(name);
		assignments.push({ position: i + 7, name: ghost ? GHOST_NAME : name, role: 'Town', is_ghost: ghost });
	});
	return assignments;
}

function randomizeFormals() {
	const formals = [];
	for (let day = 1; day <= 8; day++) {
		formals.push({ day, count: Math.floor(nextRandom() * 3) });
	}
	return formals;
}

// --- Render assignments ---

function renderAssignments(assignments, listEl) {
	listEl.innerHTML = '';
	for (const a of assignments) {
		const li = document.createElement('li');
		const posSpan = document.createElement('span');
		posSpan.className = 'pos-num';
		posSpan.textContent = a.position + '.';

		const nameSpan = document.createElement('span');
		if (a.role === 'Mafia') {
			nameSpan.className = 'mafia';
			nameSpan.textContent = `${a.name} (Mafia)`;
		} else if (a.is_ghost) {
			nameSpan.className = 'ghost';
			nameSpan.textContent = `${a.name} (Ghost)`;
		} else if (a.position === 4) {
			nameSpan.className = 'cop';
			nameSpan.textContent = `${a.name} (Cop)`;
		} else if (a.position === 5) {
			nameSpan.className = 'medic';
			nameSpan.textContent = `${a.name} (Medic)`;
		} else if (a.position === 6) {
			nameSpan.className = 'vigi';
			nameSpan.textContent = `${a.name} (Vigi)`;
		} else {
			nameSpan.className = 'town';
			nameSpan.textContent = a.name;
		}

		li.appendChild(posSpan);
		li.appendChild(nameSpan);
		listEl.appendChild(li);
	}
}

function renderFormals(formals, el) {
	el.innerHTML = '';
	for (const f of formals) {
		const div = document.createElement('div');
		div.className = 'formal-day';
		const label = document.createElement('span');
		label.className = 'formal-label';
		label.textContent = `Day ${f.day}`;
		const value = document.createElement('span');
		value.className = 'formal-count';
		value.textContent = f.count;
		div.appendChild(label);
		div.appendChild(value);
		el.appendChild(div);
	}
}

// --- Randomize (now client-side) ---

async function doRandomize() {
	const raw = $('#names-input').value;
	try {
		const names = validateNames(raw);
		$('#btn-randomize').disabled = true;
		await fillRandomPool(50);
		$('#btn-randomize').disabled = false;
		currentAssignments = randomize(names);
		currentFormals = randomizeFormals();
		autoMatchNames();
		renderEditableAssignments($('#assignments-list'));
		renderFormals(currentFormals, $('#formals-schedule'));
		rollCount++;
		$('#roll-count').textContent = rollCount;
		$('#darkstars-setup').classList.add('hidden');
		$('#manual-setup').classList.add('hidden');
		$('#retro-form').classList.add('hidden');
		$('#assignments-display').classList.remove('hidden');
		saveState();
	} catch (e) {
		$('#btn-randomize').disabled = false;
		showToast(e.message);
	}
}

// --- Fuzzy matching ---

function levenshtein(a, b) {
	const m = a.length, n = b.length;
	const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1]
				? dp[i - 1][j - 1]
				: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

function getUsedNames(names) {
	if (names) return new Set(names.map((n) => n.toLowerCase()));
	return new Set(
		currentAssignments
			.filter((a) => !a.is_ghost)
			.map((a) => a.name.toLowerCase())
	);
}

function abbreviationScore(query, name) {
	const q = query.toLowerCase();
	const nl = name.toLowerCase();
	let ni = 0;
	let score = 0;

	for (let qi = 0; qi < q.length; qi++) {
		let found = false;
		while (ni < name.length) {
			if (nl[ni] === q[qi]) {
				if (ni === 0) {
					score += 10;
				} else {
					const prev = name[ni - 1];
					const curr = name[ni];
					const prevIsLower = prev >= 'a' && prev <= 'z';
					const currIsUpper = curr >= 'A' && curr <= 'Z';
					const prevIsNonAlpha = !/[a-zA-Z]/.test(prev);
					if (prevIsNonAlpha || (prevIsLower && currIsUpper)) {
						score += 10;
					} else {
						score += 1;
					}
				}
				ni++;
				found = true;
				break;
			}
			score -= 1;
			ni++;
		}
		if (!found) return -1;
	}
	return score;
}

function findClosestPlayer(name, usedNamesOverride) {
	if (!knownPlayers.length) return null;
	const lower = name.toLowerCase();

	// For longer names, exact match means no suggestion needed.
	// For short names (<=5 chars), skip this check — they may be
	// abbreviations of a longer canonical player name.
	if (name.length > 5 && knownPlayers.some((p) => p.toLowerCase() === lower)) return null;

	const used = usedNamesOverride || getUsedNames();
	const candidates = knownPlayers.filter((p) => !used.has(p.toLowerCase()));
	if (!candidates.length) return null;

	const prefixMatches = candidates.filter((p) =>
		p.toLowerCase().startsWith(lower)
	);
	if (prefixMatches.length === 1) return prefixMatches[0];

	const substringMatches = candidates.filter((p) =>
		p.toLowerCase().includes(lower)
	);
	if (substringMatches.length === 1) return substringMatches[0];

	const scored = candidates
		.map((p) => ({ name: p, score: abbreviationScore(lower, p) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 1) return scored[0].name;
	// Shorter names need less margin — 2-char abbreviations have little
	// signal, so even a small lead is meaningful for a suggestion.
	const margin = name.length <= 2 ? 1 : name.length <= 4 ? 3 : 5;
	if (scored.length >= 2 && scored[0].score >= scored[1].score + margin) {
		return scored[0].name;
	}

	const reversePrefix = candidates.filter((p) =>
		lower.startsWith(p.toLowerCase())
	);
	if (reversePrefix.length === 1) return reversePrefix[0];

	let best = null;
	let bestDist = Infinity;
	for (const p of candidates) {
		const dist = levenshtein(lower, p.toLowerCase());
		if (dist < bestDist) {
			bestDist = dist;
			best = p;
		}
	}
	const maxLen = Math.max(name.length, best.length);
	if (bestDist <= Math.ceil(maxLen / 3)) return best;
	return null;
}

// --- Editable name rendering for record panel ---

function renderEditableAssignments(listEl = $('#locked-list')) {
	listEl.innerHTML = '';
	for (const a of currentAssignments) {
		const li = document.createElement('li');
		const posSpan = document.createElement('span');
		posSpan.className = 'pos-num';
		posSpan.textContent = a.position + '.';

		if (a.is_ghost) {
			const nameSpan = document.createElement('span');
			nameSpan.className = 'ghost';
			nameSpan.textContent = `${a.name} (Ghost)`;
			li.appendChild(posSpan);
			li.appendChild(nameSpan);
		} else {
			const nameBtn = document.createElement('button');
			const posClass = { 4: 'cop', 5: 'medic', 6: 'vigi' };
			nameBtn.className = a.role === 'Mafia'
				? 'name-btn mafia'
				: `name-btn ${posClass[a.position] || 'town'}`;
			nameBtn.textContent = a.name;
			nameBtn.title = 'Click to edit name';
			nameBtn.addEventListener('click', () => startNameEdit(a, nameBtn, listEl));
			li.appendChild(posSpan);
			li.appendChild(nameBtn);

			const exactMatch = knownPlayers.some(
				(p) => p.toLowerCase() === a.name.toLowerCase()
			);
			const suggestion = findClosestPlayer(a.name);

			if (a.skipMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				li.appendChild(badge);
			} else if (suggestion) {
				const sugBtn = document.createElement('button');
				sugBtn.className = 'name-suggestion-btn';
				sugBtn.innerHTML = `&rarr; ${suggestion}?`;
				sugBtn.title = `Rename to "${suggestion}"`;
				sugBtn.addEventListener('click', () => {
					const oldName = a.name;
					a.name = suggestion;
					renderEditableAssignments(listEl);
					rebuildNight0Checks();
					saveState();
					showToast(`Renamed "${oldName}" to "${suggestion}"`, true);
				});
				li.appendChild(sugBtn);
			} else if (exactMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge matched';
				badge.textContent = 'matched';
				li.appendChild(badge);

				const notBtn = document.createElement('button');
				notBtn.className = 'name-notmatch-btn';
				notBtn.textContent = 'not them?';
				notBtn.title = 'Mark as a different player with the same name';
				notBtn.addEventListener('click', () => {
					a.skipMatch = true;
					startNameEdit(a, nameBtn, listEl);
				});
				li.appendChild(notBtn);
			} else {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				li.appendChild(badge);
			}
		}
		listEl.appendChild(li);
	}
}

function createNameEditInput(currentName, getUsedSet, onFinish) {
	const wrapper = document.createElement('span');
	wrapper.className = 'name-edit-wrapper';

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'name-edit-input';
	input.value = currentName;

	const suggList = document.createElement('ul');
	suggList.className = 'name-suggestions hidden';

	wrapper.appendChild(input);
	wrapper.appendChild(suggList);

	let selectedIdx = -1;
	let finished = false;

	function showSuggestions(query) {
		suggList.innerHTML = '';
		selectedIdx = -1;
		if (!query) {
			suggList.classList.add('hidden');
			return;
		}
		const q = query.toLowerCase();
		const used = getUsedSet();
		used.delete(currentName.toLowerCase());
		const matches = knownPlayers
			.filter((p) => {
				const pl = p.toLowerCase();
				return pl.includes(q) && pl !== q && !used.has(pl);
			})
			.slice(0, 8);
		if (!matches.length) {
			suggList.classList.add('hidden');
			return;
		}
		for (const name of matches) {
			const li = document.createElement('li');
			li.textContent = name;
			li.addEventListener('mousedown', (e) => {
				e.preventDefault();
				finishEdit(name);
			});
			suggList.appendChild(li);
		}
		suggList.classList.remove('hidden');
	}

	function updateHighlight() {
		const items = suggList.querySelectorAll('li');
		items.forEach((li, i) => li.classList.toggle('highlighted', i === selectedIdx));
	}

	function finishEdit(newName) {
		if (finished) return;
		finished = true;
		onFinish(newName);
	}

	input.addEventListener('input', () => showSuggestions(input.value));

	input.addEventListener('keydown', (e) => {
		const items = suggList.querySelectorAll('li');
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
			updateHighlight();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIdx = Math.max(selectedIdx - 1, -1);
			updateHighlight();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (selectedIdx >= 0 && items[selectedIdx]) {
				finishEdit(items[selectedIdx].textContent);
			} else {
				finishEdit(input.value.trim() || currentName);
			}
		} else if (e.key === 'Escape') {
			finishEdit(currentName);
		}
	});

	input.addEventListener('blur', () => {
		setTimeout(() => finishEdit(input.value.trim() || currentName), 150);
	});

	return wrapper;
}

function startNameEdit(assignment, btnEl, listEl) {
	const wrapper = createNameEditInput(
		assignment.name,
		() => getUsedNames(),
		(newName) => {
			const oldName = assignment.name;
			const corrected = correctCase(newName);
			assignment.name = corrected;
			delete assignment.skipMatch;
			renderEditableAssignments(listEl);
			rebuildNight0Checks();
			saveState();
			if (oldName !== corrected) {
				showToast(`Renamed "${oldName}" to "${corrected}"`, true);
			}
		}
	);
	btnEl.replaceWith(wrapper);
	wrapper.querySelector('input').focus();
	wrapper.querySelector('input').select();
}

function startManualNameEdit(nameIndex, names, btnEl, containerId, roleMap, onChange, skipMatchSet) {
	const wrapper = createNameEditInput(
		names[nameIndex],
		() => getUsedNames(names),
		(newName) => {
			const oldName = names[nameIndex];
			const corrected = correctCase(newName);
			if (oldName !== corrected) {
				// Re-key roleMap
				if (roleMap.has(oldName)) {
					roleMap.set(corrected, roleMap.get(oldName));
					roleMap.delete(oldName);
				}
				// Update skipMatch set
				if (skipMatchSet.has(oldName)) {
					skipMatchSet.delete(oldName);
					skipMatchSet.add(corrected);
				}
				names[nameIndex] = corrected;
				// For retro: preserve N0 checkbox state across rebuild
				if (containerId === 'retro-player-list') {
					const checkedN0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
					const updatedChecked = checkedN0.map((n) => n === oldName ? corrected : n);
					buildRetroN0Checks();
					$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
						cb.checked = updatedChecked.includes(cb.value);
					});
				}
				showToast(`Renamed "${oldName}" to "${corrected}"`, true);
			}
			renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet);
			onChange();
			saveState();
		}
	);
	btnEl.replaceWith(wrapper);
	wrapper.querySelector('input').focus();
	wrapper.querySelector('input').select();
}

function rebuildNight0Checks() {
	const checks = $('#night0-checks');
	const previouslyChecked = new Set(
		[...$$('#night0-checks input:checked')].map((cb) => cb.value)
	);
	checks.innerHTML = '';
	const realPlayers = currentAssignments.filter((a) => !a.is_ghost);
	for (const a of realPlayers) {
		const label = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.value = a.name;
		cb.checked = previouslyChecked.has(a.name);
		cb.addEventListener('change', () => { updateRatedPreview(); saveState(); });
		label.appendChild(cb);
		label.appendChild(document.createTextNode(` ${a.name}`));
		checks.appendChild(label);
	}
	updateRatedPreview();
}

// --- Auto-correct names to match spreadsheet ---

function correctCase(name) {
	const lower = name.toLowerCase();
	const match = knownPlayers.find((p) => p.toLowerCase() === lower);
	return match || name;
}

function autoMatchNames() {
	const corrections = [];
	for (const a of currentAssignments) {
		if (a.is_ghost) continue;
		const corrected = correctCase(a.name);
		if (corrected !== a.name) {
			corrections.push(`${a.name} → ${corrected}`);
			a.name = corrected;
		}
	}
	for (const a of currentAssignments) {
		if (a.is_ghost) continue;
		const suggestion = findClosestPlayer(a.name);
		if (suggestion) {
			const score1 = abbreviationScore(a.name.toLowerCase(), suggestion);
			if (score1 >= a.name.length * 8) {
				corrections.push(`${a.name} → ${suggestion}`);
				a.name = suggestion;
			}
		}
	}
	if (corrections.length) {
		showToast(`Auto-matched: ${corrections.join(', ')}`, true);
	}
}

// --- Accept & go to record panel ---

function acceptAssignments() {
	rollCount = 0;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};

	$('#role-reveal-pre').textContent = generateRoleReveal();
	$('#nights-container').innerHTML = '';
	addNightSection(0);
	updateNightButtons();

	showPanel('panel-game');
	saveState();
}

// --- Manual Setup & Retroactive Entry ---

function getRoleCounts(roleMap) {
	const counts = { Mafia: 0, Cop: 0, Medic: 0, Vigi: 0 };
	for (const role of roleMap.values()) counts[role] = (counts[role] || 0) + 1;
	return counts;
}

function roleCounterText(roleMap) {
	const c = getRoleCounts(roleMap);
	return `${c.Mafia}/3 Mafia · ${c.Cop}/1 Cop · ${c.Medic}/1 Medic · ${c.Vigi}/1 Vigi`;
}

function isRoleSelectionComplete(roleMap) {
	const c = getRoleCounts(roleMap);
	return c.Mafia === 3 && c.Cop === 1 && c.Medic === 1 && c.Vigi === 1;
}

function renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet) {
	const container = $(`#${containerId}`);
	container.innerHTML = '';
	const used = getUsedNames(names);

	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const ghost = isGhostEntry(name);
		const item = document.createElement('div');
		item.className = 'manual-player-item';

		if (ghost) {
			// Ghost: static label, no editing
			const label = document.createElement('span');
			label.className = 'player-name-btn ghost-label';
			label.textContent = name;
			item.appendChild(label);
		} else {
			// Name button — click to inline edit
			const nameBtn = document.createElement('button');
			nameBtn.type = 'button';
			nameBtn.className = 'player-name-btn';
			nameBtn.textContent = name;
			nameBtn.title = 'Click to edit name';
			nameBtn.addEventListener('click', () => {
				startManualNameEdit(i, names, nameBtn, containerId, roleMap, onChange, skipMatchSet);
			});
			item.appendChild(nameBtn);

			// Name matching badges/suggestions
			const exactMatch = knownPlayers.some((p) => p.toLowerCase() === name.toLowerCase());
			const suggestion = skipMatchSet.has(name) ? null : findClosestPlayer(name, used);

			if (skipMatchSet.has(name)) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				item.appendChild(badge);
			} else if (suggestion) {
				const sugBtn = document.createElement('button');
				sugBtn.type = 'button';
				sugBtn.className = 'name-suggestion-btn';
				sugBtn.innerHTML = `&rarr; ${suggestion}?`;
				sugBtn.title = `Rename to "${suggestion}"`;
				sugBtn.addEventListener('click', () => {
					const oldName = names[i];
					if (roleMap.has(oldName)) {
						roleMap.set(suggestion, roleMap.get(oldName));
						roleMap.delete(oldName);
					}
					names[i] = suggestion;
					if (containerId === 'retro-player-list') {
						const checkedN0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
						const updatedChecked = checkedN0.map((n) => n === oldName ? suggestion : n);
						buildRetroN0Checks();
						$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
							cb.checked = updatedChecked.includes(cb.value);
						});
					}
					renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet);
					onChange();
					saveState();
					showToast(`Renamed "${oldName}" to "${suggestion}"`, true);
				});
				item.appendChild(sugBtn);
			} else if (exactMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge matched';
				badge.textContent = 'matched';
				item.appendChild(badge);

				const notBtn = document.createElement('button');
				notBtn.type = 'button';
				notBtn.className = 'name-notmatch-btn';
				notBtn.textContent = 'not them?';
				notBtn.title = 'Mark as a different player with the same name';
				notBtn.addEventListener('click', () => {
					skipMatchSet.add(name);
					startManualNameEdit(i, names, nameBtn, containerId, roleMap, onChange, skipMatchSet);
				});
				item.appendChild(notBtn);
			} else {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				item.appendChild(badge);
			}
		}

		// Role button — click to cycle role
		const roleBtn = document.createElement('button');
		roleBtn.type = 'button';
		const currentRole = roleMap.get(name) || 'Town';
		roleBtn.className = 'player-toggle' + (ROLE_CSS[currentRole] ? ` ${ROLE_CSS[currentRole]}` : '');
		roleBtn.textContent = currentRole;
		const cycle = ghost ? ROLE_CYCLE.filter(r => r !== 'Mafia') : ROLE_CYCLE;
		roleBtn.addEventListener('click', () => {
			const role = roleMap.get(name) || 'Town';
			const idx = cycle.indexOf(role);
			for (let step = 1; step <= cycle.length; step++) {
				const next = cycle[(idx + step) % cycle.length];
				if (next === 'Town') {
					roleMap.delete(name);
					roleBtn.className = 'player-toggle';
					roleBtn.textContent = 'Town';
					break;
				}
				const counts = getRoleCounts(roleMap);
				if (counts[next] < ROLE_LIMITS[next]) {
					roleMap.set(name, next);
					roleBtn.className = 'player-toggle ' + ROLE_CSS[next];
					roleBtn.textContent = next;
					break;
				}
			}
			onChange();
		});
		item.appendChild(roleBtn);

		container.appendChild(item);
	}
}

// --- Dark Stars Setup ---

function buildDarkStarsAssignments(names, setupNum) {
	const setup = DARK_STARS_SETUPS[setupNum];
	const shuffled = [...names];
	shuffleArray(shuffled);

	const assignments = [];
	// Positions 1-3: Mafia
	for (let i = 0; i < 3; i++) {
		assignments.push({ position: i + 1, name: shuffled[i], role: 'Mafia', is_ghost: false, dsRole: 'Mafia' });
	}
	// Town power roles
	for (let i = 0; i < setup.townRoles.length; i++) {
		const tr = setup.townRoles[i];
		assignments.push({
			position: i + 4,
			name: shuffled[i + 3],
			role: 'Town',
			is_ghost: false,
			dsRole: tr.label,
		});
	}
	// Remaining: plain Town
	for (let i = 3 + setup.townRoles.length; i < shuffled.length; i++) {
		assignments.push({
			position: i + 1,
			name: shuffled[i],
			role: 'Town',
			is_ghost: false,
			dsRole: 'Town',
		});
	}
	return assignments;
}

function generateDarkStarsRoleReveal() {
	const setup = DARK_STARS_SETUPS[darkStarsSetup];
	const mafia = currentAssignments.filter((a) => a.role === 'Mafia').map((a) => a.name);
	const lines = [
		`Setup: ${setup.name}`,
		`Mafia: ||${mafia.join(', ')}||`,
		`Mafia Power: ||${setup.mafiaFaction}||`,
	];
	for (const a of currentAssignments) {
		if (a.role === 'Town' && a.dsRole !== 'Town') {
			lines.push(`${a.dsRole}: ||${a.name}||`);
		}
	}
	return lines.join('\n');
}

function renderDarkStarsSetupInfo() {
	const setup = DARK_STARS_SETUPS[darkStarsSetup];
	const info = $('#darkstars-setup-info');
	info.innerHTML = `<strong>Setup ${darkStarsSetup}: ${setup.name}</strong><br>` +
		`Mafia Faction Power: <strong>${setup.mafiaFaction}</strong>` +
		(setup.mafiaFactionOneShot ? ' (one-shot)' : '') + '<br>' +
		`Town Roles: ${setup.townRoles.map((r) => r.label + (r.oneShot ? ' (1x)' : '')).join(', ')}`;
}

function doDarkStarsSetup() {
	const raw = $('#names-input').value;
	try {
		darkStarsNames = validateDarkStarsNames(raw);
		for (let i = 0; i < darkStarsNames.length; i++) darkStarsNames[i] = correctCase(darkStarsNames[i]);
		gameVariant = 'darkstars';
		gameMode = 'darkstars';

		// Random setup pick (1-3)
		darkStarsSetup = Math.floor(nextRandom() * 3) + 1;
		currentAssignments = buildDarkStarsAssignments(darkStarsNames, darkStarsSetup);

		$('#assignments-display').classList.add('hidden');
		$('#manual-setup').classList.add('hidden');
		$('#retro-form').classList.add('hidden');
		$('#darkstars-setup').classList.remove('hidden');

		renderDarkStarsSetupInfo();
		renderDarkStarsPlayerList();
		saveState();
	} catch (e) {
		showToast(e.message);
	}
}

function renderDarkStarsPlayerList() {
	const container = $('#darkstars-player-list');
	container.innerHTML = '';
	for (const a of currentAssignments) {
		const item = document.createElement('div');
		item.className = 'manual-player-item';

		const nameSpan = document.createElement('span');
		nameSpan.className = 'player-name-btn';
		nameSpan.textContent = a.name;
		item.appendChild(nameSpan);

		const roleSpan = document.createElement('span');
		const roleClass = a.role === 'Mafia' ? 'mafia' : (a.dsRole !== 'Town' ? 'ds-power' : '');
		roleSpan.className = 'player-toggle' + (roleClass ? ` ${roleClass}` : '');
		roleSpan.textContent = a.role === 'Mafia' ? 'Mafia' : a.dsRole;
		item.appendChild(roleSpan);

		container.appendChild(item);
	}
}

function rerollDarkStarsSetup() {
	darkStarsSetup = Math.floor(nextRandom() * 3) + 1;
	currentAssignments = buildDarkStarsAssignments(darkStarsNames, darkStarsSetup);
	renderDarkStarsSetupInfo();
	renderDarkStarsPlayerList();
	saveState();
}

function acceptDarkStarsSetup() {
	// Initialize one-shot tracker
	const setup = DARK_STARS_SETUPS[darkStarsSetup];
	oneShotTracker = {};
	for (const r of setup.townRoles) {
		if (r.oneShot) oneShotTracker[r.key] = false;
	}
	if (setup.mafiaFactionOneShot) oneShotTracker['mafiaFaction'] = false;

	rollCount = 0;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};

	$('#role-reveal-pre').textContent = generateDarkStarsRoleReveal();
	$('#nights-container').innerHTML = '';
	// Setups 2 & 3 have a Parity Cop N0 check; setup 1 has no N0
	if (darkStarsSetup !== 1) {
		addDarkStarsNightSection(0);
	}
	updateNightButtons();

	$('#darkstars-setup').classList.add('hidden');
	$('#btn-continue-record').textContent = 'End Game';
	showPanel('panel-game');
	saveState();
}

function doManualSetup() {
	const raw = $('#names-input').value;
	try {
		manualNames = validateNames(raw);
		for (let i = 0; i < manualNames.length; i++) manualNames[i] = correctCase(manualNames[i]);
		manualNames.push(...makeGhostNames(15 - manualNames.length));
		gameMode = 'manual';
		manualRoleMap = new Map();
		manualSkipMatch = new Set();

		$('#assignments-display').classList.add('hidden');
		$('#retro-form').classList.add('hidden');
		$('#darkstars-setup').classList.add('hidden');
		$('#manual-setup').classList.remove('hidden');

		renderManualPlayerList(manualNames, 'manual-player-list', manualRoleMap, () => {
			$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
			$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
			saveState();
		}, manualSkipMatch);

		$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
		$('#btn-manual-accept').disabled = true;
		saveState();
	} catch (e) {
		showToast(e.message);
	}
}

function acceptManualSetup() {
	currentAssignments = buildAssignments(manualNames, manualRoleMap);
	currentFormals = null;
	autoMatchNames();

	rollCount = 0;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};

	$('#role-reveal-pre').textContent = generateRoleReveal();
	$('#nights-container').innerHTML = '';
	addNightSection(0);
	updateNightButtons();

	$('#manual-setup').classList.add('hidden');
	showPanel('panel-game');
	saveState();
}

function doRetroEntry() {
	const raw = $('#names-input').value;
	try {
		retroNames = validateNames(raw);
		for (let i = 0; i < retroNames.length; i++) retroNames[i] = correctCase(retroNames[i]);
		retroNames.push(...makeGhostNames(15 - retroNames.length));
		gameMode = 'retroactive';
		retroRoleMap = new Map();
		retroSkipMatch = new Set();

		$('#assignments-display').classList.add('hidden');
		$('#manual-setup').classList.add('hidden');
		$('#darkstars-setup').classList.add('hidden');
		$('#retro-form').classList.remove('hidden');

		renderManualPlayerList(retroNames, 'retro-player-list', retroRoleMap, () => {
			updateRetroForm();
			saveState();
		}, retroSkipMatch);

		$$('input[name="retro-winner"]').forEach((r) => (r.checked = false));
		buildRetroN0Checks();
		$('#retro-mafia-counter').textContent = roleCounterText(retroRoleMap);
		$('#retro-rated-preview').textContent = `${retroNames.filter(n => !isGhostEntry(n)).length} players will be rated`;
		$('#btn-retro-submit').disabled = true;
		saveState();
	} catch (e) {
		showToast(e.message);
	}
}

function buildRetroN0Checks() {
	const checks = $('#retro-n0-checks');
	checks.innerHTML = '';
	for (const name of retroNames.filter(n => !isGhostEntry(n))) {
		const label = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.value = name;
		cb.addEventListener('change', () => { updateRetroForm(); saveState(); });
		label.appendChild(cb);
		label.appendChild(document.createTextNode(` ${name}`));
		checks.appendChild(label);
	}
}

function updateRetroForm() {
	$('#retro-mafia-counter').textContent = roleCounterText(retroRoleMap);

	const n0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
	const realCount = retroNames.filter(n => !isGhostEntry(n)).length;
	const rated = realCount - n0.length;
	$('#retro-rated-preview').textContent = `${rated} players will be rated`;

	const winner = document.querySelector('input[name="retro-winner"]:checked');
	$('#btn-retro-submit').disabled = !(isRoleSelectionComplete(retroRoleMap) && winner);
}

async function submitRetroGame() {
	const winner = document.querySelector('input[name="retro-winner"]:checked');
	if (!winner || !isRoleSelectionComplete(retroRoleMap)) return;

	const n0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);

	currentAssignments = buildAssignments(retroNames, retroRoleMap);
	autoMatchNames();

	const password = await confirmAction(
		`Record past game: <strong>${winner.value} Win</strong>` +
		(n0.length ? `<br>Night 0 kills: ${n0.join(', ')}` : '') +
		'<br><br>This will update the Google Sheet. Continue?',
		true
	);
	if (!password) return;

	$('#btn-retro-submit').disabled = true;
	try {
		const result = await api('recordGame', {
			assignments: currentAssignments,
			winner: winner.value,
			night0_kills: n0,
			password,
		});

		clearSavedState();
		gameMode = 'randomize';
		await loadPlayerNames();
		renderResults(result);
		showPanel('panel-results');
		showToast(`Game ${result.game_id} recorded`, true);
		loadLastGame();
	} catch (e) {
		showToast(e.message);
		$('#btn-retro-submit').disabled = false;
	}
}

// --- Update rated preview ---

function updateRatedPreview() {
	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);
	const real = currentAssignments.filter((a) => !a.is_ghost);
	const rated = real.length - n0.length;
	$('#rated-preview').textContent = `${rated} players will be rated`;

	const winner = document.querySelector('input[name="winner"]:checked');
	$('#btn-submit').disabled = !winner;
}

// --- Confirmation dialog ---

function confirmAction(message, requirePassword = false) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'overlay';
		const dialog = document.createElement('div');
		dialog.className = 'confirm-dialog';
		dialog.innerHTML = `
      <p>${message}</p>
      ${requirePassword ? '<input type="password" id="confirm-password" placeholder="Enter password">' : ''}
      <div class="button-row">
        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-ok">Confirm</button>
      </div>
    `;
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const pwInput = dialog.querySelector('#confirm-password');
		if (pwInput) pwInput.focus();

		dialog.querySelector('#confirm-ok').addEventListener('click', () => {
			document.body.removeChild(overlay);
			resolve(requirePassword ? (pwInput.value || false) : true);
		});
		dialog.querySelector('#confirm-cancel').addEventListener('click', () => {
			document.body.removeChild(overlay);
			resolve(false);
		});
	});
}

// --- Submit results ---

async function submitResults() {
	const winner = document.querySelector('input[name="winner"]:checked');
	if (!winner) {
		showToast('Select a winner first');
		return;
	}

	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);

	const password = await confirmAction(
		`Record game: <strong>${winner.value} Win</strong>` +
		(n0.length ? `<br>Night 0 kills: ${n0.join(', ')}` : '') +
		'<br><br>This will update the Google Sheet. Continue?',
		true
	);
	if (!password) return;

	$('#btn-submit').disabled = true;
	try {
		const result = await api('recordGame', {
			assignments: currentAssignments,
			winner: winner.value,
			night0_kills: n0,
			password,
		});

		clearSavedState();
		await loadPlayerNames();
		renderResults(result);
		showPanel('panel-results');
		showToast(`Game ${result.game_id} recorded`, true);
		loadLastGame();
	} catch (e) {
		showToast(e.message);
		$('#btn-submit').disabled = false;
	}
}

// --- Render results ---

function renderResults(result) {
	const tbody = $('#results-table tbody');
	tbody.innerHTML = '';

	const medals = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };
	const rankClass = (r) => {
		if (r === 1) return 'rank-gold';
		if (r === 2) return 'rank-silver';
		if (r === 3) return 'rank-bronze';
		if (r <= 15) return 'rank-top15';
		return '';
	};

	for (const p of result.players) {
		const tr = document.createElement('tr');
		const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
		const isExcluded = p.result === 'Ghost' || p.result === 'Night Zero';

		if (isExcluded) {
			tr.innerHTML = `
      <td>-</td>
      <td>${p.name}</td>
      <td class="${alignClass}">${p.alignment}</td>
      <td>${p.result}</td>
      <td>-</td>
      <td>-</td>
      <td>0</td>
    `;
			tr.classList.add('excluded-row');
		} else {
			const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
			const resultClass = p.result === 'Win' ? 'change-pos' : 'change-neg';
			const sign = p.rate_change >= 0 ? '+' : '';
			const rank = playerRankMap.get(p.name) ?? '-';
			const rc = typeof rank === 'number' ? rankClass(rank) : '';
			tr.innerHTML = `
      <td class="${rc}">${medals[rank] || rank}</td>
      <td>${p.name}</td>
      <td class="${alignClass}">${p.alignment}</td>
      <td class="${resultClass}">${p.result}</td>
      <td>${p.old_rating}</td>
      <td>${p.new_rating}</td>
      <td class="${changeClass}">${sign}${p.rate_change}</td>
    `;
		}
		tbody.appendChild(tr);
	}

	const rolesDiv = $('#roles-summary');
	rolesDiv.innerHTML = '';

	const excl = $('#excluded-summary');
	const parts = [];
	if (result.excluded.ghosts.length) {
		parts.push(`Ghosts: ${result.excluded.ghosts.length}`);
	}
	if (result.excluded.night0_kills.length) {
		parts.push(`Night 0 kills: ${result.excluded.night0_kills.join(', ')}`);
	}
	excl.textContent = parts.length
		? `Excluded from rating: ${parts.join(' | ')}`
		: 'All players rated';
}

// --- Load last game ---

async function loadLastGame() {
	const undoBtn = $('#btn-undo-last');
	try {
		const data = await api('getLastGame');
		const container = $('#last-game-content');
		if (!data.game) {
			container.textContent = 'No games recorded yet';
			undoBtn?.classList.add('hidden');
			return;
		}

		const medals = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };
		const rankClass = (r) => {
			if (r === 1) return 'rank-gold';
			if (r === 2) return 'rank-silver';
			if (r === 3) return 'rank-bronze';
			if (r <= 15) return 'rank-top15';
			return '';
		};

		let html = `<p><strong>Game #${data.game.game_id}</strong></p>`;
		html += `<table><thead><tr>
      <th>#</th><th>Player</th><th>Alignment</th><th>Result</th><th>Rating</th><th>Change</th>
    </tr></thead><tbody>`;

		for (const p of data.game.players) {
			const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
			const isExcluded = p.result === 'Ghost' || p.result === 'Night Zero';
			if (isExcluded) {
				html += `<tr class="excluded-row">
        <td>-</td>
        <td>${p.player}</td>
        <td class="${alignClass}">${p.alignment}</td>
        <td>${p.result}</td>
        <td>-</td>
        <td>0</td>
      </tr>`;
			} else {
				const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
				const resultClass = p.result === 'Win' ? 'change-pos' : 'change-neg';
				const sign = p.rate_change >= 0 ? '+' : '';
				const rank = playerRankMap.get(p.player) ?? '-';
				const rc = typeof rank === 'number' ? rankClass(rank) : '';
				html += `<tr>
        <td class="${rc}">${medals[rank] || rank}</td>
        <td>${p.player}</td>
        <td class="${alignClass}">${p.alignment}</td>
        <td class="${resultClass}">${p.result}</td>
        <td>${p.new_rating}</td>
        <td class="${changeClass}">${sign}${p.rate_change}</td>
      </tr>`;
			}
		}
		html += '</tbody></table>';
		container.innerHTML = html;
		undoBtn?.classList.remove('hidden');
	} catch (e) {
		$('#last-game-content').textContent = 'Failed to load last game';
		undoBtn?.classList.add('hidden');
	}
}

// --- Undo last game ---

async function undoLastGame() {
	const password = await confirmAction(
		'Undo the last recorded game?<br><br>This will restore all player ratings to their previous values and delete the game from history.',
		true
	);
	if (!password) return;

	const btn = $('#btn-undo-last');
	btn.disabled = true;
	try {
		const result = await api('undoLastGame', { password });
		showToast(`Game ${result.undone_game_id} undone (${result.players_restored.length} players restored)`, true);
		await loadPlayerNames();
		await loadLastGame();
	} catch (e) {
		showToast(e.message);
	} finally {
		btn.disabled = false;
	}
}

// --- New game ---

function newGame() {
	clearSavedState();
	currentAssignments = null;
	currentFormals = null;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};
	gameMode = 'randomize';
	gameVariant = 'allstars';
	darkStarsSetup = null;
	oneShotTracker = {};
	darkStarsNames = [];
	manualRoleMap = new Map();
	retroRoleMap = new Map();
	manualNames = [];
	retroNames = [];
	manualSkipMatch = new Set();
	retroSkipMatch = new Set();
	$('#names-input').value = '';
	$('#assignments-display').classList.add('hidden');
	$('#manual-setup').classList.add('hidden');
	$('#retro-form').classList.add('hidden');
	$('#darkstars-setup').classList.add('hidden');
	$('#btn-continue-record').textContent = 'Continue to Record';
	$('#nights-container').innerHTML = '';
	countNames();
	showPanel('panel-randomize');
}

// --- Load player names ---

async function loadPlayerNames() {
	try {
		const data = await api('getPlayers');
		knownPlayers = data.players.map((p) => p.name);
		const byRating = [...data.players].sort((a, b) => b.rating - a.rating);
		playerRankMap = new Map();
		byRating.forEach((p, i) => playerRankMap.set(p.name, i + 1));
	} catch (e) {
		// Non-critical, autocomplete just won't work
	}
}

// --- Night Actions & Game Panel ---

function getAlignment(name) {
	const a = currentAssignments.find((p) => p.name === name);
	return a ? a.role : null;
}

function generateRoleReveal() {
	const mafia = currentAssignments.filter((a) => a.position <= 3).map((a) => a.name);
	const cop = currentAssignments.find((a) => a.position === 4);
	const medic = currentAssignments.find((a) => a.position === 5);
	const vigi = currentAssignments.find((a) => a.position === 6);

	return [
		`Mafia: ||${mafia.join(', ')}||`,
		`Cop: ||${cop.name}||`,
		`Medic: ||${medic.name}||`,
		`Vigi: ||${vigi.name}||`,
	].join('\n');
}

function createPlayerSelect(players, placeholder) {
	const sel = document.createElement('select');
	sel.className = 'night-select';

	const defaultOpt = document.createElement('option');
	defaultOpt.value = '';
	defaultOpt.textContent = placeholder;
	sel.appendChild(defaultOpt);

	for (const p of players) {
		const opt = document.createElement('option');
		opt.value = p.name;
		opt.textContent = p.name;
		sel.appendChild(opt);
	}

	return sel;
}

function calculateCopResult(target, nightIndex) {
	if (nightIndex === 0 || !target) return null;

	let prevCheck = null;
	for (let i = nightIndex - 1; i >= 0; i--) {
		if (nightActions[i] && nightActions[i].copCheck) {
			prevCheck = nightActions[i].copCheck;
			break;
		}
	}
	if (!prevCheck) return null;

	const targetAlignment = getAlignment(target);
	const prevAlignment = getAlignment(prevCheck);
	if (!targetAlignment || !prevAlignment) return null;

	return targetAlignment === prevAlignment ? 'SAME' : 'DIFFERENT';
}

function updateCopBadge(nightIndex) {
	const nd = nightActions[nightIndex];
	const badge = $(`#cop-badge-${nd.night}`);
	if (!badge) return;

	if (nd.copResult) {
		badge.textContent = nd.copResult;
		badge.className = `cop-result-badge ${nd.copResult.toLowerCase()}`;
	} else {
		badge.textContent = '';
		badge.className = 'cop-result-badge';
	}
}

function recalculateCopResults(fromIndex) {
	for (let i = fromIndex; i < nightActions.length; i++) {
		const nd = nightActions[i];
		nd.copResult = calculateCopResult(nd.copCheck, i);
		updateCopBadge(i);
		updateNightOutput(nd.night);
	}
}

function generateNightOutput(nightData) {
	const kills = [...new Set(nightData.mafKills.filter(Boolean))];
	let output = '';

	if (kills.length) {
		output += `mafia: ||killed ${kills.join(', ')}||\n`;
	}

	if (nightData.copCheck) {
		if (nightData.night > 0 && nightData.copResult) {
			let prevTarget = null;
			for (let i = nightData.night - 1; i >= 0; i--) {
				if (nightActions[i] && nightActions[i].copCheck) {
					prevTarget = nightActions[i].copCheck;
					break;
				}
			}
			if (prevTarget) {
				output += `cop: ||check ${nightData.copCheck} - ${nightData.copResult} to ${prevTarget}||\n`;
			} else {
				output += `cop: ||check ${nightData.copCheck}||\n`;
			}
		} else {
			output += `cop: ||check ${nightData.copCheck}||\n`;
		}
	}

	if (nightData.medicSave) {
		output += `medic: ||saved ${nightData.medicSave}||\n`;
	}

	if (nightData.vigiTarget) {
		output += `vigi: ||shot ${nightData.vigiTarget}||\n`;
	} else if (nightData.vigiActive) {
		output += `vigi: ||holstered||\n`;
	}

	if (nightData.rngs !== '') {
		output += `rngs: ${nightData.rngs}`;
	}

	return output.trimEnd();
}

function updateNightOutput(nightNum) {
	const nightData = nightActions.find((n) => n.night === nightNum);
	if (!nightData) return;

	const pre = $(`#night-output-${nightNum}`);
	if (pre) {
		pre.textContent = gameMode === 'darkstars'
			? generateDarkStarsNightOutput(nightData)
			: generateNightOutput(nightData);
	}
}

function handleCopyClick(e) {
	const btn = e.target.closest('.btn-copy');
	if (!btn) return;

	const targetId = btn.dataset.target;
	const pre = document.getElementById(targetId);
	if (!pre) return;

	navigator.clipboard.writeText(pre.textContent).then(() => {
		btn.textContent = 'Copied!';
		btn.classList.add('copied');
		setTimeout(() => {
			btn.textContent = 'Copy';
			btn.classList.remove('copied');
		}, 2000);
	});
}

function getNextNightNum() {
	if (nightActions.length === 0) {
		// Dark Stars setup 1 skips N0
		if (gameMode === 'darkstars' && darkStarsSetup === 1) return 1;
		return 0;
	}
	return nightActions[nightActions.length - 1].night + 1;
}

function updateNightButtons() {
	const container = $('#night-buttons');
	container.innerHTML = '';
	const gameOver = !!checkWinCondition();
	const startNight = (gameMode === 'darkstars' && darkStarsSetup === 1) ? 1 : 0;
	const nextNight = getNextNightNum();

	for (let i = startNight; i <= 7; i++) {
		const btn = document.createElement('button');
		btn.className = 'btn-night';
		btn.textContent = `N${i}`;
		btn.dataset.night = i;

		const isUsed = nightActions.some((nd) => nd.night === i);
		if (isUsed) {
			btn.disabled = true;
			btn.classList.add('used');
		} else if (i === nextNight && !gameOver) {
			btn.addEventListener('click', () => {
				if (gameMode === 'darkstars') {
					addDarkStarsNightSection(i);
				} else {
					addNightSection(i);
				}
				updateNightButtons();
			});
		} else {
			btn.disabled = true;
		}

		container.appendChild(btn);
	}
}

function checkWinCondition() {
	if (!currentAssignments) return null;

	const dead = new Set();
	for (let i = 0; i < nightActions.length; i++) addNightKills(dead, i);
	for (const name of Object.values(dayVotes)) {
		if (name) dead.add(name);
	}

	const mafia = currentAssignments.filter((a) => a.role === 'Mafia');
	const town = currentAssignments.filter((a) => a.role !== 'Mafia' && !a.is_ghost);
	const aliveMafia = mafia.filter((a) => !dead.has(a.name)).length;
	const aliveTown = town.filter((a) => !dead.has(a.name)).length;

	if (aliveMafia === 0) return { winner: 'Town', mafia: aliveMafia, town: aliveTown };
	if (aliveMafia >= aliveTown) return { winner: 'Mafia', mafia: aliveMafia, town: aliveTown };
	return null;
}

function updateWinIndicator() {
	const result = checkWinCondition();
	const el = $('#win-indicator');
	if (!el) return;

	if (result) {
		const cls = result.winner === 'Mafia' ? 'mafia-win' : 'town-win';
		el.textContent = `${result.winner} wins! (${result.mafia} mafia vs ${result.town} town)`;
		el.className = `win-indicator ${cls}`;
	} else {
		el.className = 'win-indicator hidden';
	}
}

function addNightKills(deadSet, nightIndex) {
	const nd = nightActions[nightIndex];
	if (!nd) return;
	const killCounts = {};
	for (const kill of nd.mafKills) {
		if (kill) killCounts[kill] = (killCounts[kill] || 0) + 1;
	}
	if (nd.vigiTarget) killCounts[nd.vigiTarget] = (killCounts[nd.vigiTarget] || 0) + 1;

	if (nd.darkStars) {
		// Dark Stars: Split Vigi adds a kill
		if (nd.darkStars.splitVigiTarget) {
			killCounts[nd.darkStars.splitVigiTarget] = (killCounts[nd.darkStars.splitVigiTarget] || 0) + 1;
		}
		// Nerfed Medic saves (1 or 2)
		for (const save of [nd.darkStars.nerfedMedicA, nd.darkStars.nerfedMedicB].filter(Boolean)) {
			if (killCounts[save]) killCounts[save]--;
		}
	} else {
		// All Stars medic save
		if (nd.medicSave && killCounts[nd.medicSave]) {
			killCounts[nd.medicSave]--;
		}
	}

	for (const [name, count] of Object.entries(killCounts)) {
		if (count > 0) deadSet.add(name);
	}
}

function getDeadBeforeNight(n) {
	const dead = new Set();
	for (let i = 0; i < nightActions.length; i++) {
		if (nightActions[i].night < n) addNightKills(dead, i);
	}
	for (let d = 1; d <= n; d++) {
		if (dayVotes[d]) dead.add(dayVotes[d]);
	}
	return dead;
}

function getDeadBeforeDay(d) {
	const dead = new Set();
	for (let i = 0; i < nightActions.length; i++) {
		if (nightActions[i].night < d) addNightKills(dead, i);
	}
	for (let dd = 1; dd < d; dd++) {
		if (dayVotes[dd]) dead.add(dayVotes[dd]);
	}
	return dead;
}

function refreshDarkStarsConstraints() {
	const setup = DARK_STARS_SETUPS[darkStarsSetup];

	// Recalculate one-shot tracker from nightActions
	oneShotTracker = {};
	for (const r of setup.townRoles) {
		if (r.oneShot) oneShotTracker[r.key] = false;
	}
	if (setup.mafiaFactionOneShot) oneShotTracker['mafiaFaction'] = false;

	for (const nd of nightActions) {
		if (!nd.darkStars) continue;
		if (nd.vigiShot) oneShotTracker['vigi'] = true;
		if (nd.darkStars.roleblockTarget) oneShotTracker['mafiaFaction'] = true;
		if (nd.darkStars.splitVigiTarget) oneShotTracker['mafiaFaction'] = true;
		if (nd.darkStars.morticianA?.target) oneShotTracker['morticianA'] = true;
		if (nd.darkStars.morticianB?.target) oneShotTracker['morticianB'] = true;
	}

	for (let idx = 0; idx < nightActions.length; idx++) {
		const nd = nightActions[idx];
		const n = nd.night; // use night number for DOM queries
		const dead = getDeadBeforeNight(n);
		const ds = nd.darkStars;
		if (!ds) continue;

		// Collect all selects for this night for generic dead-disabling
		const allSels = [
			...$$(`[data-night="${n}"].maf-select`),
			$(`.ds-rolecop-select[data-night="${n}"]`),
			$(`.ds-roleblock-select[data-night="${n}"]`),
			$(`.ds-splitvigi-select[data-night="${n}"]`),
			$(`.ds-paritycop-select[data-night="${n}"]`),
			...$$(`.ds-nerfedmedic-select[data-night="${n}"]`),
			$(`.ds-vigi-select[data-night="${n}"]`),
		].filter(Boolean);

		// Enable all options first
		for (const sel of allSels) {
			sel.disabled = false;
			sel.querySelectorAll('option').forEach((opt) => { opt.disabled = false; });
		}

		// Disable dead players in all selects (except mortician which targets dead)
		for (const sel of allSels) {
			if (sel.classList.contains('ds-mortician-select')) continue;
			sel.querySelectorAll('option').forEach((opt) => {
				if (opt.value !== '' && dead.has(opt.value)) opt.disabled = true;
			});
		}

		// Mortician: only show dead players
		$$(`[data-night="${n}"].ds-mortician-select`).forEach((mSel) => {
			const mortKey = mSel.dataset.mortKey;
			// Rebuild options with current dead players
			const currentVal = mSel.value;
			mSel.innerHTML = '';
			const defaultOpt = document.createElement('option');
			defaultOpt.value = '';
			defaultOpt.textContent = 'No check';
			mSel.appendChild(defaultOpt);
			for (const name of dead) {
				const opt = document.createElement('option');
				opt.value = name;
				opt.textContent = name;
				mSel.appendChild(opt);
			}
			mSel.value = dead.has(currentVal) ? currentVal : '';
			if (mSel.value !== currentVal) ds[mortKey].target = mSel.value;

			// One-shot: disable if used on a different night
			const usedOnOtherNight = oneShotTracker[mortKey] &&
				!nd.darkStars[mortKey]?.target;
			if (usedOnOtherNight) {
				mSel.disabled = true;
				mSel.value = '';
				ds[mortKey].target = '';
			}
			const spentEl = $(`#ds-${mortKey}-spent-${n}`);
			if (spentEl) spentEl.classList.toggle('hidden', !usedOnOtherNight);

			// Disable result if no target
			const resultSel = $(`.ds-mortician-result[data-night="${n}"][data-mort-key="${mortKey}"]`);
			if (resultSel) resultSel.disabled = !mSel.value;

			// Disable if holder is dead
			const holderLabel = setup.townRoles.find((r) => r.key === mortKey)?.label;
			const holder = currentAssignments.find((a) => a.dsRole === holderLabel);
			if (holder && dead.has(holder.name)) {
				mSel.disabled = true;
				mSel.value = '';
				ds[mortKey].target = '';
			}
		});

		// Nerfed Medic constraints
		$$(`[data-night="${n}"].ds-nerfedmedic-select`).forEach((nmSel) => {
			const medicKey = nmSel.dataset.medicKey;
			const holderLabel = setup.townRoles.find((r) => r.key === medicKey)?.label;
			const holder = currentAssignments.find((a) => a.dsRole === holderLabel);

			// No consecutive save on same target
			if (idx > 0 && nightActions[idx - 1].darkStars) {
				const prevSave = nightActions[idx - 1].darkStars[medicKey];
				if (prevSave) {
					nmSel.querySelectorAll('option').forEach((opt) => {
						if (opt.value === prevSave) opt.disabled = true;
					});
				}
			}

			// Disable if holder is dead
			if (holder && dead.has(holder.name)) {
				nmSel.disabled = true;
				nmSel.value = '';
				ds[medicKey] = '';
			}
		});

		// Parity Cop: disable if holder is dead
		const pcSel = $(`.ds-paritycop-select[data-night="${n}"]`);
		if (pcSel) {
			const holder = currentAssignments.find((a) => a.dsRole === 'Parity Cop');
			if (holder && dead.has(holder.name)) {
				pcSel.disabled = true;
				pcSel.value = '';
				ds.parityCopTarget = '';
			}
			const pcResult = $(`.ds-paritycop-result[data-night="${n}"]`);
			if (pcResult) pcResult.disabled = !pcSel.value;
		}

		// Rolecop: disable if all mafia dead (shouldn't happen but safety)
		const rcSel = $(`.ds-rolecop-select[data-night="${n}"]`);
		if (rcSel) {
			const rcInput = $(`.ds-rolecop-result[data-night="${n}"]`);
			if (rcInput) rcInput.disabled = !rcSel.value;
		}

		// Roleblock (one-shot)
		const rbSel = $(`.ds-roleblock-select[data-night="${n}"]`);
		if (rbSel) {
			const usedOnOther = oneShotTracker['mafiaFaction'] && !ds.roleblockTarget;
			if (usedOnOther) rbSel.disabled = true;
			const spentEl = $(`#ds-faction-spent-${n}`);
			if (spentEl) spentEl.classList.toggle('hidden', !usedOnOther);
		}

		// Split Vigi (one-shot)
		const svSel = $(`.ds-splitvigi-select[data-night="${n}"]`);
		if (svSel) {
			const usedOnOther = oneShotTracker['mafiaFaction'] && !ds.splitVigiTarget;
			if (usedOnOther) svSel.disabled = true;
			const spentEl = $(`#ds-faction-spent-${n}`);
			if (spentEl) spentEl.classList.toggle('hidden', !usedOnOther);
		}

		// Town Vigi (one-shot)
		const vSel = $(`.ds-vigi-select[data-night="${n}"]`);
		if (vSel) {
			const holder = currentAssignments.find((a) => a.dsRole === 'Vigilante');
			if (holder && dead.has(holder.name)) {
				vSel.disabled = true;
				vSel.value = '';
				nd.vigiTarget = '';
				nd.vigiShot = false;
			}
			const usedOnOther = oneShotTracker['vigi'] && !nd.vigiShot;
			if (usedOnOther) vSel.disabled = true;
			const spentEl = $(`#ds-vigi-spent-${n}`);
			if (spentEl) spentEl.classList.toggle('hidden', vSel.disabled ? false : !usedOnOther);
		}

		// Day vote selects
		if (n > 0) {
			const daySel = $(`.day-vote-select[data-day="${n}"]`);
			if (daySel) {
				const dayDead = getDeadBeforeDay(n);
				daySel.querySelectorAll('option').forEach((opt) => {
					opt.disabled = opt.value !== '' && dayDead.has(opt.value);
				});
				if (dayDead.has(daySel.value)) {
					daySel.value = '';
					dayVotes[n] = '';
				}
			}
		}

		// Reset invalid selections
		for (const sel of allSels) {
			if (sel.disabled) continue;
			const chosen = sel.querySelector(`option[value="${CSS.escape(sel.value)}"]`);
			if (chosen && chosen.disabled) {
				sel.value = '';
				if (sel.classList.contains('maf-select')) {
					nd.mafKills[parseInt(sel.dataset.kill)] = '';
				} else if (sel.classList.contains('ds-vigi-select')) {
					nd.vigiTarget = '';
					nd.vigiShot = false;
				} else if (sel.classList.contains('ds-nerfedmedic-select')) {
					ds[sel.dataset.medicKey] = '';
				} else if (sel.classList.contains('ds-paritycop-select')) {
					ds.parityCopTarget = '';
				} else if (sel.classList.contains('ds-rolecop-select')) {
					ds.rolecopTarget = '';
				} else if (sel.classList.contains('ds-roleblock-select')) {
					ds.roleblockTarget = '';
				} else if (sel.classList.contains('ds-splitvigi-select')) {
					ds.splitVigiTarget = '';
				}
			}
		}

		// Vigi active flag for output
		nd.vigiActive = vSel && !vSel.disabled;

		updateNightOutput(n);
	}

	// Recalculate one-shot tracker after constraint processing
	vigiHasShot = nightActions.some((nd) => nd.vigiShot);
	updateWinIndicator();
	updateNightButtons();
	saveState();
}

function refreshConstraints() {
	if (gameMode === 'darkstars') return refreshDarkStarsConstraints();
	const cop = currentAssignments.find((a) => a.position === 4);
	const medic = currentAssignments.find((a) => a.position === 5);
	const vigi = currentAssignments.find((a) => a.position === 6);
	vigiHasShot = nightActions.some((nd) => nd.vigiShot);

	for (let n = 0; n < nightActions.length; n++) {
		const nd = nightActions[n];
		const dead = getDeadBeforeNight(n);

		// Show/hide mafia kills based on alive count and N0 player count
		const mafiaNames = currentAssignments.filter((a) => a.role === 'Mafia').map((a) => a.name);
		const aliveMafia = mafiaNames.filter((name) => !dead.has(name)).length;
		const realCount = currentAssignments.filter((a) => !a.is_ghost).length;

		const mafKill1Wrapper = $(`.maf-kill-1-wrapper[data-night="${n}"]`);
		const mafKill2Wrapper = $(`.maf-kill-2-wrapper[data-night="${n}"]`);

		// Kill 1: hidden only on N0 with 13 players
		if (mafKill1Wrapper) {
			if (n === 0 && realCount <= 13) {
				mafKill1Wrapper.classList.add('hidden');
				nd.mafKills[0] = '';
			} else {
				mafKill1Wrapper.classList.remove('hidden');
			}
		}

		// Kill 2: hidden if <3 mafia alive OR N0 with <15 players
		if (mafKill2Wrapper) {
			if (aliveMafia < 3 || (n === 0 && realCount < 15)) {
				mafKill2Wrapper.classList.add('hidden');
				const mafSel2 = mafKill2Wrapper.querySelector('.maf-select');
				if (mafSel2) {
					mafSel2.value = '';
					nd.mafKills[1] = '';
				}
			} else {
				mafKill2Wrapper.classList.remove('hidden');
			}
		}

		// N0: no vigi shot, no medic save with 13 players
		const vigiWrap = $(`.vigi-wrapper[data-night="${n}"]`);
		if (vigiWrap) {
			if (n === 0) {
				vigiWrap.classList.add('hidden');
				nd.vigiTarget = '';
				nd.vigiShot = false;
			} else {
				vigiWrap.classList.remove('hidden');
			}
		}

		const medicWrap = $(`.medic-wrapper[data-night="${n}"]`);
		if (medicWrap) {
			if (n === 0 && realCount <= 13) {
				medicWrap.classList.add('hidden');
				nd.medicSave = '';
			} else {
				medicWrap.classList.remove('hidden');
			}
		}

		// Update day vote select (Day n precedes Night n)
		if (n > 0) {
			const daySel = $(`.day-vote-select[data-day="${n}"]`);
			if (daySel) {
				const dayDead = getDeadBeforeDay(n);
				daySel.querySelectorAll('option').forEach((opt) => {
					opt.disabled = opt.value !== '' && dayDead.has(opt.value);
				});
				if (dayDead.has(daySel.value)) {
					daySel.value = '';
					dayVotes[n] = '';
				}
			}
		}

		// Collect all night selects for this night
		const allSels = [
			...$$(`[data-night="${n}"].maf-select`),
			$(`.cop-select[data-night="${n}"]`),
			$(`.medic-select[data-night="${n}"]`),
			$(`.vigi-select[data-night="${n}"]`),
		].filter(Boolean);

		// Enable all options first
		for (const sel of allSels) {
			sel.disabled = false;
			sel.querySelectorAll('option').forEach((opt) => {
				opt.disabled = false;
			});
		}

		// Disable dead players in all selects
		for (const sel of allSels) {
			sel.querySelectorAll('option').forEach((opt) => {
				if (opt.value !== '' && dead.has(opt.value)) opt.disabled = true;
			});
		}

		// Cop no-repeat constraint
		const copSel = $(`.cop-select[data-night="${n}"]`);
		if (copSel) {
			const usedChecks = new Set();
			for (let j = 0; j < n; j++) {
				if (nightActions[j].copCheck) usedChecks.add(nightActions[j].copCheck);
			}
			copSel.querySelectorAll('option').forEach((opt) => {
				if (opt.value !== '' && usedChecks.has(opt.value)) opt.disabled = true;
			});
		}

		// Medic no-consecutive constraint
		const medicSel = $(`.medic-select[data-night="${n}"]`);
		if (medicSel) {
			const prevSave = n > 0 ? nightActions[n - 1].medicSave : '';
			if (prevSave) {
				medicSel.querySelectorAll('option').forEach((opt) => {
					if (opt.value === prevSave) opt.disabled = true;
				});
			}
		}

		// Role holder death — disable entire select if holder is dead
		if (cop && (cop.is_ghost || dead.has(cop.name)) && copSel) {
			copSel.disabled = true;
			copSel.value = '';
			nd.copCheck = '';
		}
		if (medic && (medic.is_ghost || dead.has(medic.name)) && medicSel) {
			medicSel.disabled = true;
			medicSel.value = '';
			nd.medicSave = '';
		}
		const vigiSel = $(`.vigi-select[data-night="${n}"]`);
		if (vigi && (vigi.is_ghost || dead.has(vigi.name)) && vigiSel) {
			vigiSel.disabled = true;
			vigiSel.value = '';
			nd.vigiTarget = '';
			nd.vigiShot = false;
		}

		// Vigi one-shot constraint
		if (vigiSel && !vigiSel.disabled) {
			if (vigiHasShot && !nd.vigiShot) {
				vigiSel.disabled = true;
			}
		}
		const spentEl = $(`#vigi-spent-${n}`);
		if (spentEl) {
			const showSpent = vigiSel && vigiSel.disabled && !(vigi && dead.has(vigi.name));
			spentEl.classList.toggle('hidden', !showSpent);
		}

		// Reset invalid selections (current value is disabled)
		for (const sel of allSels) {
			if (sel.disabled) continue;
			const chosen = sel.querySelector(`option[value="${CSS.escape(sel.value)}"]`);
			if (chosen && chosen.disabled) {
				sel.value = '';
				// Sync back to data model
				if (sel.classList.contains('maf-select')) {
					nd.mafKills[parseInt(sel.dataset.kill)] = '';
				} else if (sel.classList.contains('cop-select')) {
					nd.copCheck = '';
				} else if (sel.classList.contains('medic-select')) {
					nd.medicSave = '';
				} else if (sel.classList.contains('vigi-select')) {
					nd.vigiTarget = '';
					nd.vigiShot = false;
				}
			}
		}

		nd.vigiActive = n > 0 && vigiSel && !vigiSel.disabled;
		updateNightOutput(n);
	}

	// Recalculate vigiHasShot after potential resets
	vigiHasShot = nightActions.some((nd) => nd.vigiShot);
	recalculateCopResults(0);
	updateWinIndicator();
	updateNightButtons();
	saveState();
}

function addDaySection(dayNum) {
	const allReal = currentAssignments.filter((a) => !a.is_ghost);
	dayVotes[dayNum] = '';

	const section = document.createElement('div');
	section.className = 'day-section';
	section.dataset.day = dayNum;

	const heading = document.createElement('h3');
	heading.textContent = `Day ${dayNum}`;
	section.appendChild(heading);

	const label = document.createElement('label');
	label.className = 'night-label';
	label.textContent = 'Voted Out';
	section.appendChild(label);

	const sel = createPlayerSelect(allReal, 'No one');
	sel.classList.add('day-vote-select');
	sel.dataset.day = dayNum;
	sel.addEventListener('change', () => {
		dayVotes[dayNum] = sel.value;
		refreshConstraints();
	});
	section.appendChild(sel);

	$('#nights-container').appendChild(section);
}

function addNightSection(nightNum) {
	const nonMafia = currentAssignments.filter((a) => !a.is_ghost && a.role !== 'Mafia');
	const allReal = currentAssignments.filter((a) => !a.is_ghost);
	const copTargets = allReal.filter((a) => a.position !== 4);
	const medicTargets = allReal.filter((a) => a.position !== 5);
	const vigiTargets = allReal.filter((a) => a.position !== 6);

	// Insert day section before night (except N0)
	if (nightNum > 0) {
		addDaySection(nightNum);
	}

	const nightData = {
		night: nightNum,
		mafKills: ['', ''],
		copCheck: '',
		copResult: null,
		medicSave: '',
		vigiTarget: '',
		vigiShot: false,
		vigiActive: false,
		rngs: '',
	};
	nightActions.push(nightData);

	const section = document.createElement('div');
	section.className = 'night-section';

	const heading = document.createElement('h3');
	heading.textContent = `Night ${nightNum}`;
	section.appendChild(heading);

	// Mafia Kill 1
	const mafKill1Wrapper = document.createElement('div');
	mafKill1Wrapper.className = 'maf-kill-1-wrapper';
	mafKill1Wrapper.dataset.night = nightNum;

	const mafLabel1 = document.createElement('label');
	mafLabel1.className = 'night-label';
	mafLabel1.textContent = 'Mafia Kill 1';
	mafKill1Wrapper.appendChild(mafLabel1);

	const mafSel1 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel1.classList.add('maf-select');
	mafSel1.dataset.night = nightNum;
	mafSel1.dataset.kill = '0';
	mafSel1.addEventListener('change', () => {
		nightData.mafKills[0] = mafSel1.value;
		refreshConstraints();
	});
	mafKill1Wrapper.appendChild(mafSel1);

	section.appendChild(mafKill1Wrapper);

	// Mafia Kill 2 (only available when 3 mafia alive)
	const mafKill2Wrapper = document.createElement('div');
	mafKill2Wrapper.className = 'maf-kill-2-wrapper';
	mafKill2Wrapper.dataset.night = nightNum;

	const mafLabel2 = document.createElement('label');
	mafLabel2.className = 'night-label';
	mafLabel2.textContent = 'Mafia Kill 2';
	mafKill2Wrapper.appendChild(mafLabel2);

	const mafSel2 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel2.classList.add('maf-select');
	mafSel2.dataset.night = nightNum;
	mafSel2.dataset.kill = '1';
	mafSel2.addEventListener('change', () => {
		nightData.mafKills[1] = mafSel2.value;
		refreshConstraints();
	});
	mafKill2Wrapper.appendChild(mafSel2);

	section.appendChild(mafKill2Wrapper);

	// Cop Check
	const copLabel = document.createElement('label');
	copLabel.className = 'night-label';
	copLabel.textContent = 'Cop Check';
	section.appendChild(copLabel);

	const copRow = document.createElement('div');
	copRow.className = 'night-field-row';

	const copSel = createPlayerSelect(copTargets, 'Select target...');
	copSel.classList.add('cop-select');
	copSel.dataset.night = nightNum;
	copSel.addEventListener('change', () => {
		nightData.copCheck = copSel.value;
		refreshConstraints();
	});
	copRow.appendChild(copSel);

	const copBadge = document.createElement('span');
	copBadge.className = 'cop-result-badge';
	copBadge.id = `cop-badge-${nightNum}`;
	copRow.appendChild(copBadge);

	section.appendChild(copRow);

	// Medic Save
	const medicWrapper = document.createElement('div');
	medicWrapper.className = 'medic-wrapper';
	medicWrapper.dataset.night = nightNum;

	const medicLabel = document.createElement('label');
	medicLabel.className = 'night-label';
	medicLabel.textContent = 'Medic Save';
	medicWrapper.appendChild(medicLabel);

	const medicSel = createPlayerSelect(medicTargets, 'Select target...');
	medicSel.classList.add('medic-select');
	medicSel.dataset.night = nightNum;
	medicSel.addEventListener('change', () => {
		nightData.medicSave = medicSel.value;
		refreshConstraints();
	});
	medicWrapper.appendChild(medicSel);

	section.appendChild(medicWrapper);

	// Vigilante
	const vigiWrapper = document.createElement('div');
	vigiWrapper.className = 'vigi-wrapper';
	vigiWrapper.dataset.night = nightNum;

	const vigiLabel = document.createElement('label');
	vigiLabel.className = 'night-label';
	vigiLabel.textContent = 'Vigilante';
	vigiWrapper.appendChild(vigiLabel);

	const vigiRow = document.createElement('div');
	vigiRow.className = 'night-field-row';

	const vigiSel = createPlayerSelect(vigiTargets, 'Holster');
	vigiSel.classList.add('vigi-select');
	vigiSel.dataset.night = nightNum;
	vigiSel.addEventListener('change', () => {
		nightData.vigiTarget = vigiSel.value;
		nightData.vigiShot = !!vigiSel.value;
		refreshConstraints();
	});
	vigiRow.appendChild(vigiSel);

	const vigiSpent = document.createElement('span');
	vigiSpent.className = 'vigi-spent hidden';
	vigiSpent.id = `vigi-spent-${nightNum}`;
	vigiSpent.textContent = 'Shot already used';
	vigiRow.appendChild(vigiSpent);

	vigiWrapper.appendChild(vigiRow);

	section.appendChild(vigiWrapper);

	// RNGs (predetermined from formals)
	const rngsCount = currentFormals && currentFormals[nightNum]
		? currentFormals[nightNum].count
		: 0;
	nightData.rngs = rngsCount;

	const rngsLabel = document.createElement('label');
	rngsLabel.className = 'night-label';
	rngsLabel.textContent = 'RNGs';
	section.appendChild(rngsLabel);

	const rngsValue = document.createElement('span');
	rngsValue.className = 'night-rngs';
	rngsValue.textContent = rngsCount;
	section.appendChild(rngsValue);

	// Discord output block
	const outputBlock = document.createElement('div');
	outputBlock.className = 'discord-block';

	const outputHeader = document.createElement('div');
	outputHeader.className = 'discord-header';

	const outputTitle = document.createElement('span');
	outputTitle.textContent = `Night ${nightNum} Output`;
	outputHeader.appendChild(outputTitle);

	const copyBtn = document.createElement('button');
	copyBtn.className = 'btn-copy';
	copyBtn.dataset.target = `night-output-${nightNum}`;
	copyBtn.textContent = 'Copy';
	outputHeader.appendChild(copyBtn);

	outputBlock.appendChild(outputHeader);

	const outputPre = document.createElement('pre');
	outputPre.className = 'discord-pre';
	outputPre.id = `night-output-${nightNum}`;
	outputBlock.appendChild(outputPre);

	section.appendChild(outputBlock);

	$('#nights-container').appendChild(section);
	refreshConstraints();
}

// --- Dark Stars Night Section ---

function createResultSelect(options, placeholder) {
	const sel = document.createElement('select');
	sel.className = 'night-select ds-result-select';
	const defaultOpt = document.createElement('option');
	defaultOpt.value = '';
	defaultOpt.textContent = placeholder;
	sel.appendChild(defaultOpt);
	for (const val of options) {
		const opt = document.createElement('option');
		opt.value = val;
		opt.textContent = val;
		sel.appendChild(opt);
	}
	return sel;
}

function makeDarkStarsNightData(nightNum) {
	return {
		night: nightNum,
		mafKills: ['', ''],
		vigiTarget: '',
		vigiShot: false,
		vigiActive: false,
		rngs: '',
		darkStars: {
			rolecopTarget: '', rolecopResult: '',
			roleblockTarget: '',
			splitVigiTarget: '',
			morticianA: { target: '', result: '' },
			morticianB: { target: '', result: '' },
			parityCopTarget: '', parityCopResult: '',
			nerfedMedicA: '', nerfedMedicB: '',
		},
	};
}

function addDarkStarsNightSection(nightNum) {
	const setup = DARK_STARS_SETUPS[darkStarsSetup];
	const nonMafia = currentAssignments.filter((a) => a.role !== 'Mafia');
	const allReal = currentAssignments;
	const isN0 = nightNum === 0;

	// Day-start: insert day section before every night (including N1)
	if (nightNum > 0) {
		addDaySection(nightNum);
	}

	const nightData = makeDarkStarsNightData(nightNum);
	nightActions.push(nightData);

	const section = document.createElement('div');
	section.className = 'night-section';

	const heading = document.createElement('h3');
	heading.textContent = `Night ${nightNum}`;
	section.appendChild(heading);

	// N0: only Parity Cop check (setups 2 & 3)
	if (isN0) {
		// Parity Cop N0 check
		const pcWrapper = document.createElement('div');
		pcWrapper.className = 'ds-paritycop-wrapper';
		pcWrapper.dataset.night = nightNum;

		const pcLabel = document.createElement('label');
		pcLabel.className = 'night-label';
		pcLabel.textContent = 'Parity Cop (N0 Check)';
		pcWrapper.appendChild(pcLabel);

		const pcRow = document.createElement('div');
		pcRow.className = 'night-field-row';

		const pcSel = createPlayerSelect(allReal, 'Select target...');
		pcSel.classList.add('ds-paritycop-select');
		pcSel.dataset.night = nightNum;
		pcSel.addEventListener('change', () => {
			nightData.darkStars.parityCopTarget = pcSel.value;
			updateNightOutput(nightNum);
		});
		pcRow.appendChild(pcSel);

		pcWrapper.appendChild(pcRow);
		section.appendChild(pcWrapper);

		// Discord output block
		const outputBlock = document.createElement('div');
		outputBlock.className = 'discord-block';
		const outputHeader = document.createElement('div');
		outputHeader.className = 'discord-header';
		const outputTitle = document.createElement('span');
		outputTitle.textContent = `Night ${nightNum} Output`;
		outputHeader.appendChild(outputTitle);
		const copyBtn = document.createElement('button');
		copyBtn.className = 'btn-copy';
		copyBtn.dataset.target = `night-output-${nightNum}`;
		copyBtn.textContent = 'Copy';
		outputHeader.appendChild(copyBtn);
		outputBlock.appendChild(outputHeader);
		const outputPre = document.createElement('pre');
		outputPre.className = 'discord-pre';
		outputPre.id = `night-output-${nightNum}`;
		outputBlock.appendChild(outputPre);
		section.appendChild(outputBlock);

		$('#nights-container').appendChild(section);
		refreshConstraints();
		return;
	}

	// Mafia Kill 1 (always present, always visible)
	const mafKill1Wrapper = document.createElement('div');
	mafKill1Wrapper.className = 'maf-kill-1-wrapper ds-always';
	mafKill1Wrapper.dataset.night = nightNum;

	const mafLabel1 = document.createElement('label');
	mafLabel1.className = 'night-label';
	mafLabel1.textContent = 'Mafia Kill 1';
	mafKill1Wrapper.appendChild(mafLabel1);

	const mafSel1 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel1.classList.add('maf-select');
	mafSel1.dataset.night = nightNum;
	mafSel1.dataset.kill = '0';
	mafSel1.addEventListener('change', () => {
		nightData.mafKills[0] = mafSel1.value;
		refreshConstraints();
	});
	mafKill1Wrapper.appendChild(mafSel1);
	section.appendChild(mafKill1Wrapper);

	// Mafia Kill 2 (always present in Dark Stars)
	const mafKill2Wrapper = document.createElement('div');
	mafKill2Wrapper.className = 'maf-kill-2-wrapper ds-always';
	mafKill2Wrapper.dataset.night = nightNum;

	const mafLabel2 = document.createElement('label');
	mafLabel2.className = 'night-label';
	mafLabel2.textContent = 'Mafia Kill 2';
	mafKill2Wrapper.appendChild(mafLabel2);

	const mafSel2 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel2.classList.add('maf-select');
	mafSel2.dataset.night = nightNum;
	mafSel2.dataset.kill = '1';
	mafSel2.addEventListener('change', () => {
		nightData.mafKills[1] = mafSel2.value;
		refreshConstraints();
	});
	mafKill2Wrapper.appendChild(mafSel2);
	section.appendChild(mafKill2Wrapper);

	// Mafia Faction Power
	if (darkStarsSetup === 1) {
		// Rolecop (every night)
		const rcWrapper = document.createElement('div');
		rcWrapper.className = 'ds-rolecop-wrapper';
		rcWrapper.dataset.night = nightNum;

		const rcLabel = document.createElement('label');
		rcLabel.className = 'night-label';
		rcLabel.textContent = 'Rolecop';
		rcWrapper.appendChild(rcLabel);

		const rcSel = createPlayerSelect(nonMafia, 'Select target...');
		rcSel.classList.add('ds-rolecop-select');
		rcSel.dataset.night = nightNum;
		rcSel.addEventListener('change', () => {
			nightData.darkStars.rolecopTarget = rcSel.value;
			refreshConstraints();
		});
		rcWrapper.appendChild(rcSel);

		const rcInput = document.createElement('input');
		rcInput.type = 'text';
		rcInput.className = 'ds-rolecop-result';
		rcInput.dataset.night = nightNum;
		rcInput.placeholder = 'Role result...';
		rcInput.addEventListener('input', () => {
			nightData.darkStars.rolecopResult = rcInput.value;
			updateNightOutput(nightNum);
		});
		rcWrapper.appendChild(rcInput);

		section.appendChild(rcWrapper);
	} else if (darkStarsSetup === 2) {
		// Roleblock (one-shot)
		const rbWrapper = document.createElement('div');
		rbWrapper.className = 'ds-roleblock-wrapper';
		rbWrapper.dataset.night = nightNum;

		const rbLabel = document.createElement('label');
		rbLabel.className = 'night-label';
		rbLabel.textContent = 'Roleblock';
		rbWrapper.appendChild(rbLabel);

		const rbRow = document.createElement('div');
		rbRow.className = 'night-field-row';

		const rbSel = createPlayerSelect(allReal, 'Select target...');
		rbSel.classList.add('ds-roleblock-select');
		rbSel.dataset.night = nightNum;
		rbSel.addEventListener('change', () => {
			nightData.darkStars.roleblockTarget = rbSel.value;
			if (rbSel.value) oneShotTracker['mafiaFaction'] = true;
			refreshConstraints();
		});
		rbRow.appendChild(rbSel);

		const rbSpent = document.createElement('span');
		rbSpent.className = 'vigi-spent hidden';
		rbSpent.id = `ds-faction-spent-${nightNum}`;
		rbSpent.textContent = 'Already used';
		rbRow.appendChild(rbSpent);

		rbWrapper.appendChild(rbRow);
		section.appendChild(rbWrapper);
	} else if (darkStarsSetup === 3) {
		// Split Vigi (one-shot, adds a kill)
		const svWrapper = document.createElement('div');
		svWrapper.className = 'ds-splitvigi-wrapper';
		svWrapper.dataset.night = nightNum;

		const svLabel = document.createElement('label');
		svLabel.className = 'night-label';
		svLabel.textContent = 'Split Vigi (Mafia)';
		svWrapper.appendChild(svLabel);

		const svRow = document.createElement('div');
		svRow.className = 'night-field-row';

		const svSel = createPlayerSelect(nonMafia, 'No shot');
		svSel.classList.add('ds-splitvigi-select');
		svSel.dataset.night = nightNum;
		svSel.addEventListener('change', () => {
			nightData.darkStars.splitVigiTarget = svSel.value;
			if (svSel.value) oneShotTracker['mafiaFaction'] = true;
			refreshConstraints();
		});
		svRow.appendChild(svSel);

		const svSpent = document.createElement('span');
		svSpent.className = 'vigi-spent hidden';
		svSpent.id = `ds-faction-spent-${nightNum}`;
		svSpent.textContent = 'Already used';
		svRow.appendChild(svSpent);

		svWrapper.appendChild(svRow);
		section.appendChild(svWrapper);
	}

	// Town Roles — build dynamically from setup definition
	for (const tr of setup.townRoles) {
		if (tr.key.startsWith('mortician')) {
			// Mortician: pick a dead player, get alignment result
			const mWrapper = document.createElement('div');
			mWrapper.className = `ds-mortician-wrapper`;
			mWrapper.dataset.night = nightNum;
			mWrapper.dataset.mortKey = tr.key;

			const mLabel = document.createElement('label');
			mLabel.className = 'night-label';
			mLabel.textContent = tr.label;
			mWrapper.appendChild(mLabel);

			const mRow = document.createElement('div');
			mRow.className = 'night-field-row';

			// Target select — will be populated with dead players in refreshConstraints
			const mSel = createPlayerSelect([], 'No check');
			mSel.classList.add('ds-mortician-select');
			mSel.dataset.night = nightNum;
			mSel.dataset.mortKey = tr.key;
			mSel.addEventListener('change', () => {
				nightData.darkStars[tr.key].target = mSel.value;
				if (mSel.value) oneShotTracker[tr.key] = true;
				refreshConstraints();
			});
			mRow.appendChild(mSel);

			const mResult = createResultSelect(['Town', 'Mafia'], 'Result...');
			mResult.classList.add('ds-mortician-result');
			mResult.dataset.night = nightNum;
			mResult.dataset.mortKey = tr.key;
			mResult.addEventListener('change', () => {
				nightData.darkStars[tr.key].result = mResult.value;
				updateNightOutput(nightNum);
			});
			mRow.appendChild(mResult);

			const mSpent = document.createElement('span');
			mSpent.className = 'vigi-spent hidden';
			mSpent.id = `ds-${tr.key}-spent-${nightNum}`;
			mSpent.textContent = 'Already used';
			mRow.appendChild(mSpent);

			mWrapper.appendChild(mRow);
			section.appendChild(mWrapper);
		} else if (tr.key === 'parityCop') {
			// Parity Cop: pick living player, moderator sets Even/Odd
			const pcWrapper = document.createElement('div');
			pcWrapper.className = 'ds-paritycop-wrapper';
			pcWrapper.dataset.night = nightNum;

			const pcLabel = document.createElement('label');
			pcLabel.className = 'night-label';
			pcLabel.textContent = tr.label;
			pcWrapper.appendChild(pcLabel);

			const pcRow = document.createElement('div');
			pcRow.className = 'night-field-row';

			const pcSel = createPlayerSelect(allReal, 'Select target...');
			pcSel.classList.add('ds-paritycop-select');
			pcSel.dataset.night = nightNum;
			pcSel.addEventListener('change', () => {
				nightData.darkStars.parityCopTarget = pcSel.value;
				refreshConstraints();
			});
			pcRow.appendChild(pcSel);

			const pcResult = createResultSelect(['Even', 'Odd'], 'Result...');
			pcResult.classList.add('ds-paritycop-result');
			pcResult.dataset.night = nightNum;
			pcResult.addEventListener('change', () => {
				nightData.darkStars.parityCopResult = pcResult.value;
				updateNightOutput(nightNum);
			});
			pcRow.appendChild(pcResult);

			pcWrapper.appendChild(pcRow);
			section.appendChild(pcWrapper);
		} else if (tr.key.startsWith('nerfedMedic')) {
			// Nerfed Medic: pick living player (no self, no consecutive repeat)
			const nmWrapper = document.createElement('div');
			nmWrapper.className = 'ds-nerfedmedic-wrapper';
			nmWrapper.dataset.night = nightNum;
			nmWrapper.dataset.medicKey = tr.key;

			const nmLabel = document.createElement('label');
			nmLabel.className = 'night-label';
			nmLabel.textContent = tr.label;
			nmWrapper.appendChild(nmLabel);

			const holder = currentAssignments.find((a) => a.dsRole === tr.label);
			const nmTargets = allReal.filter((a) => a.name !== holder?.name);
			const nmSel = createPlayerSelect(nmTargets, 'No save');
			nmSel.classList.add('ds-nerfedmedic-select');
			nmSel.dataset.night = nightNum;
			nmSel.dataset.medicKey = tr.key;
			nmSel.addEventListener('change', () => {
				nightData.darkStars[tr.key] = nmSel.value;
				refreshConstraints();
			});
			nmWrapper.appendChild(nmSel);
			section.appendChild(nmWrapper);
		} else if (tr.key === 'vigi') {
			// Town Vigilante (one-shot)
			const vWrapper = document.createElement('div');
			vWrapper.className = 'ds-vigi-wrapper';
			vWrapper.dataset.night = nightNum;

			const vLabel = document.createElement('label');
			vLabel.className = 'night-label';
			vLabel.textContent = tr.label;
			vWrapper.appendChild(vLabel);

			const vRow = document.createElement('div');
			vRow.className = 'night-field-row';

			const vigiTargets = allReal.filter((a) => {
				const holder = currentAssignments.find((h) => h.dsRole === tr.label);
				return a.name !== holder?.name;
			});
			const vSel = createPlayerSelect(vigiTargets, 'Holster');
			vSel.classList.add('ds-vigi-select');
			vSel.dataset.night = nightNum;
			vSel.addEventListener('change', () => {
				nightData.vigiTarget = vSel.value;
				nightData.vigiShot = !!vSel.value;
				if (vSel.value) oneShotTracker['vigi'] = true;
				refreshConstraints();
			});
			vRow.appendChild(vSel);

			const vSpent = document.createElement('span');
			vSpent.className = 'vigi-spent hidden';
			vSpent.id = `ds-vigi-spent-${nightNum}`;
			vSpent.textContent = 'Shot already used';
			vRow.appendChild(vSpent);

			vWrapper.appendChild(vRow);
			section.appendChild(vWrapper);
		}
	}

	// RNGs input
	nightData.rngs = '';
	const rngsLabel = document.createElement('label');
	rngsLabel.className = 'night-label';
	rngsLabel.textContent = 'RNGs';
	section.appendChild(rngsLabel);

	const rngsInput = document.createElement('input');
	rngsInput.type = 'number';
	rngsInput.className = 'ds-rngs-input';
	rngsInput.dataset.night = nightNum;
	rngsInput.min = '0';
	rngsInput.placeholder = '0';
	rngsInput.addEventListener('input', () => {
		nightData.rngs = rngsInput.value;
		updateNightOutput(nightNum);
	});
	section.appendChild(rngsInput);

	// Discord output block
	const outputBlock = document.createElement('div');
	outputBlock.className = 'discord-block';

	const outputHeader = document.createElement('div');
	outputHeader.className = 'discord-header';

	const outputTitle = document.createElement('span');
	outputTitle.textContent = `Night ${nightNum} Output`;
	outputHeader.appendChild(outputTitle);

	const copyBtn = document.createElement('button');
	copyBtn.className = 'btn-copy';
	copyBtn.dataset.target = `night-output-${nightNum}`;
	copyBtn.textContent = 'Copy';
	outputHeader.appendChild(copyBtn);

	outputBlock.appendChild(outputHeader);

	const outputPre = document.createElement('pre');
	outputPre.className = 'discord-pre';
	outputPre.id = `night-output-${nightNum}`;
	outputBlock.appendChild(outputPre);

	section.appendChild(outputBlock);

	$('#nights-container').appendChild(section);
	refreshConstraints();
}

// --- Dark Stars Night Output ---

function generateDarkStarsNightOutput(nightData) {
	const ds = nightData.darkStars;
	const kills = [...new Set(nightData.mafKills.filter(Boolean))];
	let output = '';

	if (kills.length) {
		output += `mafia: ||killed ${kills.join(', ')}||\n`;
	}

	// Mafia faction power
	if (darkStarsSetup === 1 && ds.rolecopTarget) {
		output += `rolecop: ||checked ${ds.rolecopTarget}${ds.rolecopResult ? ' — ' + ds.rolecopResult : ''}||\n`;
	} else if (darkStarsSetup === 2 && ds.roleblockTarget) {
		output += `roleblock: ||blocked ${ds.roleblockTarget}||\n`;
	} else if (darkStarsSetup === 3 && ds.splitVigiTarget) {
		output += `split vigi: ||shot ${ds.splitVigiTarget}||\n`;
	}

	// Town roles
	if (ds.morticianA?.target) {
		output += `mortician A: ||checked ${ds.morticianA.target}${ds.morticianA.result ? ' — ' + ds.morticianA.result : ''}||\n`;
	}
	if (ds.morticianB?.target) {
		output += `mortician B: ||checked ${ds.morticianB.target}${ds.morticianB.result ? ' — ' + ds.morticianB.result : ''}||\n`;
	}
	if (ds.parityCopTarget) {
		output += `parity cop: ||checked ${ds.parityCopTarget}${ds.parityCopResult ? ' — ' + ds.parityCopResult : ''}||\n`;
	}
	if (ds.nerfedMedicA) {
		output += `medic${ds.nerfedMedicB !== undefined ? ' A' : ''}: ||saved ${ds.nerfedMedicA}||\n`;
	}
	if (ds.nerfedMedicB) {
		output += `medic B: ||saved ${ds.nerfedMedicB}||\n`;
	}

	if (nightData.vigiTarget) {
		output += `vigi: ||shot ${nightData.vigiTarget}||\n`;
	} else if (nightData.vigiActive) {
		output += `vigi: ||holstered||\n`;
	}

	if (nightData.rngs !== '') {
		output += `rngs: ${nightData.rngs}`;
	}

	return output.trimEnd();
}

async function continueToRecord() {
	if (gameMode === 'darkstars') {
		const winResult = checkWinCondition();
		const winText = winResult ? `${winResult.winner} wins!` : 'Game in progress';
		if (await confirmAction(`End Dark Stars game?<br><br>${winText}<br>This game will not be recorded.`)) {
			newGame();
		}
		return;
	}
	renderEditableAssignments();
	if (currentFormals) {
		renderFormals(currentFormals, $('#locked-formals'));
		$('#locked-formals').previousElementSibling.classList.remove('hidden');
		$('#locked-formals').classList.remove('hidden');
	} else {
		$('#locked-formals').previousElementSibling.classList.add('hidden');
		$('#locked-formals').classList.add('hidden');
	}
	rebuildNight0Checks();

	// Auto-check N0 mafia kill targets
	if (nightActions.length > 0) {
		const n0Medic = nightActions[0].medicSave;
		const n0KillCounts = {};
		for (const k of nightActions[0].mafKills) {
			if (k) n0KillCounts[k] = (n0KillCounts[k] || 0) + 1;
		}
		if (n0Medic && n0KillCounts[n0Medic]) n0KillCounts[n0Medic]--;
		const n0Kills = Object.entries(n0KillCounts).filter(([, c]) => c > 0).map(([name]) => name);
		$$('#night0-checks input[type="checkbox"]').forEach((cb) => {
			cb.checked = n0Kills.includes(cb.value);
		});
	}

	$$('input[name="winner"]').forEach((r) => (r.checked = false));
	const winResult = checkWinCondition();
	if (winResult) {
		const radio = $(`input[name="winner"][value="${winResult.winner}"]`);
		if (radio) radio.checked = true;
	}
	$('#btn-submit').disabled = !winResult;
	updateRatedPreview();

	showPanel('panel-record');
	saveState();
}

// --- State persistence ---

function saveState() {
	const state = {
		currentAssignments, currentFormals, nightActions,
		dayVotes, vigiHasShot, rollCount, gameMode,
		gameVariant, darkStarsSetup, oneShotTracker, darkStarsNames,
		activePanel: $('.panel:not(.hidden)')?.id,
	};
	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);
	if (n0.length) state.n0Checks = n0;
	const winRadio = $('input[name="winner"]:checked');
	if (winRadio) state.winner = winRadio.value;

	if (gameMode === 'manual') {
		state.manualRoleMap = [...manualRoleMap];
		state.manualSkipMatch = [...manualSkipMatch];
		state.manualNames = manualNames;
	} else if (gameMode === 'retroactive') {
		state.retroRoleMap = [...retroRoleMap];
		state.retroSkipMatch = [...retroSkipMatch];
		state.retroNames = retroNames;
		const retroWinner = document.querySelector('input[name="retro-winner"]:checked');
		if (retroWinner) state.retroWinner = retroWinner.value;
		state.retroN0Checks = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
	}

	localStorage.setItem('mafiaGameState', JSON.stringify(state));
}

function clearSavedState() {
	localStorage.removeItem('mafiaGameState');
}

function restoreSelectValues(savedNights, savedDayVotes) {
	for (const nd of savedNights) {
		const n = nd.night;
		const mafSel1 = $(`.maf-select[data-night="${n}"][data-kill="0"]`);
		const mafSel2 = $(`.maf-select[data-night="${n}"][data-kill="1"]`);
		const copSel = $(`.cop-select[data-night="${n}"]`);
		const medicSel = $(`.medic-select[data-night="${n}"]`);
		const vigiSel = $(`.vigi-select[data-night="${n}"]`);
		if (mafSel1) mafSel1.value = nd.mafKills[0];
		if (mafSel2) mafSel2.value = nd.mafKills[1];
		if (copSel) copSel.value = nd.copCheck;
		if (medicSel) medicSel.value = nd.medicSave;
		if (vigiSel) vigiSel.value = nd.vigiTarget;
	}
	for (const [day, name] of Object.entries(savedDayVotes)) {
		const sel = $(`.day-vote-select[data-day="${day}"]`);
		if (sel) sel.value = name;
	}
}

function restoreDarkStarsSelectValues(savedNights, savedDayVotes) {
	for (const nd of savedNights) {
		const n = nd.night;
		const mafSel1 = $(`.maf-select[data-night="${n}"][data-kill="0"]`);
		const mafSel2 = $(`.maf-select[data-night="${n}"][data-kill="1"]`);
		if (mafSel1) mafSel1.value = nd.mafKills[0];
		if (mafSel2) mafSel2.value = nd.mafKills[1];

		const ds = nd.darkStars;
		if (!ds) continue;

		const rcSel = $(`.ds-rolecop-select[data-night="${n}"]`);
		const rcInput = $(`.ds-rolecop-result[data-night="${n}"]`);
		if (rcSel) rcSel.value = ds.rolecopTarget;
		if (rcInput) rcInput.value = ds.rolecopResult;

		const rbSel = $(`.ds-roleblock-select[data-night="${n}"]`);
		if (rbSel) rbSel.value = ds.roleblockTarget;

		const svSel = $(`.ds-splitvigi-select[data-night="${n}"]`);
		if (svSel) svSel.value = ds.splitVigiTarget;

		const pcSel = $(`.ds-paritycop-select[data-night="${n}"]`);
		const pcResult = $(`.ds-paritycop-result[data-night="${n}"]`);
		if (pcSel) pcSel.value = ds.parityCopTarget;
		if (pcResult) pcResult.value = ds.parityCopResult;

		// Mortician selects are populated in refreshConstraints, so values are set after
		$$(`[data-night="${n}"].ds-nerfedmedic-select`).forEach((sel) => {
			const key = sel.dataset.medicKey;
			if (ds[key]) sel.value = ds[key];
		});

		const vSel = $(`.ds-vigi-select[data-night="${n}"]`);
		if (vSel) vSel.value = nd.vigiTarget;

		const rngsInput = $(`.ds-rngs-input[data-night="${n}"]`);
		if (rngsInput && nd.rngs !== '') rngsInput.value = nd.rngs;
	}
	for (const [day, name] of Object.entries(savedDayVotes)) {
		const sel = $(`.day-vote-select[data-day="${day}"]`);
		if (sel) sel.value = name;
	}
}

function rebuildGamePanel(savedNights, savedDayVotes) {
	if (gameMode === 'darkstars') {
		$('#role-reveal-pre').textContent = generateDarkStarsRoleReveal();
		$('#btn-continue-record').textContent = 'End Game';
	} else {
		$('#role-reveal-pre').textContent = generateRoleReveal();
		$('#btn-continue-record').textContent = 'Continue to Record';
	}
	$('#nights-container').innerHTML = '';
	nightActions = [];
	dayVotes = {};

	for (const nd of savedNights) {
		if (gameMode === 'darkstars') {
			addDarkStarsNightSection(nd.night);
		} else {
			addNightSection(nd.night);
		}
	}

	// Overwrite fresh nightActions with saved data
	for (let i = 0; i < savedNights.length; i++) {
		Object.assign(nightActions[i], savedNights[i]);
	}
	Object.assign(dayVotes, savedDayVotes);

	if (gameMode === 'darkstars') {
		restoreDarkStarsSelectValues(savedNights, savedDayVotes);
		refreshConstraints();
		// Restore mortician values after refresh (options are rebuilt there)
		for (const nd of savedNights) {
			const ds = nd.darkStars;
			if (!ds) continue;
			$$(`[data-night="${nd.night}"].ds-mortician-select`).forEach((sel) => {
				const key = sel.dataset.mortKey;
				if (ds[key]?.target) sel.value = ds[key].target;
			});
			$$(`[data-night="${nd.night}"].ds-mortician-result`).forEach((sel) => {
				const key = sel.dataset.mortKey;
				if (ds[key]?.result) sel.value = ds[key].result;
			});
		}
	} else {
		restoreSelectValues(savedNights, savedDayVotes);
		refreshConstraints();
	}
	updateNightButtons();
}

async function restoreState() {
	const raw = localStorage.getItem('mafiaGameState');
	if (!raw) return false;

	try {
		const state = JSON.parse(raw);
		gameMode = state.gameMode || 'randomize';
		gameVariant = state.gameVariant || 'allstars';
		darkStarsSetup = state.darkStarsSetup || null;
		oneShotTracker = state.oneShotTracker || {};
		darkStarsNames = state.darkStarsNames || [];

		// Restore Dark Stars setup panel
		if (state.activePanel === 'panel-randomize' && gameMode === 'darkstars' && state.currentAssignments) {
			currentAssignments = state.currentAssignments;
			$('#assignments-display').classList.add('hidden');
			$('#manual-setup').classList.add('hidden');
			$('#retro-form').classList.add('hidden');
			$('#darkstars-setup').classList.remove('hidden');
			renderDarkStarsSetupInfo();
			renderDarkStarsPlayerList();
			showPanel('panel-randomize');
			return true;
		}

		// Restore manual/retro state on randomize panel even without assignments
		if (state.activePanel === 'panel-randomize' && gameMode === 'manual' && state.manualNames) {
			manualNames = state.manualNames;
			manualRoleMap = new Map(state.manualRoleMap || []);
			manualSkipMatch = new Set(state.manualSkipMatch || []);
			$('#names-input').value = manualNames.join('\n');
			countNames();
			$('#assignments-display').classList.add('hidden');
			$('#retro-form').classList.add('hidden');
			$('#manual-setup').classList.remove('hidden');
			renderManualPlayerList(manualNames, 'manual-player-list', manualRoleMap, () => {
				$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
				$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
				saveState();
			}, manualSkipMatch);
			$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
			$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
			showPanel('panel-randomize');
			return true;
		}

		if (state.activePanel === 'panel-randomize' && gameMode === 'retroactive' && state.retroNames) {
			retroNames = state.retroNames;
			retroRoleMap = new Map(state.retroRoleMap || []);
			retroSkipMatch = new Set(state.retroSkipMatch || []);
			$('#names-input').value = retroNames.join('\n');
			countNames();
			$('#assignments-display').classList.add('hidden');
			$('#manual-setup').classList.add('hidden');
			$('#retro-form').classList.remove('hidden');
			renderManualPlayerList(retroNames, 'retro-player-list', retroRoleMap, () => {
				updateRetroForm();
				saveState();
			}, retroSkipMatch);
			buildRetroN0Checks();
			if (state.retroN0Checks) {
				$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
					cb.checked = state.retroN0Checks.includes(cb.value);
				});
			}
			if (state.retroWinner) {
				const radio = $(`input[name="retro-winner"][value="${state.retroWinner}"]`);
				if (radio) radio.checked = true;
			}
			updateRetroForm();
			showPanel('panel-randomize');
			return true;
		}

		if (!state.currentAssignments) return false;

		currentAssignments = state.currentAssignments;
		currentFormals = state.currentFormals;
		vigiHasShot = state.vigiHasShot || false;
		rollCount = state.rollCount || 0;

		const savedNights = state.nightActions || [];
		const savedDayVotes = state.dayVotes || {};
		const panel = state.activePanel;

		if (panel === 'panel-randomize') {
			renderEditableAssignments($('#assignments-list'));
			if (currentFormals) renderFormals(currentFormals, $('#formals-schedule'));
			$('#roll-count').textContent = rollCount;
			$('#assignments-display').classList.remove('hidden');
			showPanel('panel-randomize');
		} else if (panel === 'panel-game') {
			rebuildGamePanel(savedNights, savedDayVotes);
			showPanel('panel-game');
		} else if (panel === 'panel-record') {
			rebuildGamePanel(savedNights, savedDayVotes);
			continueToRecord();
			// Restore N0 checkboxes
			if (state.n0Checks) {
				$$('#night0-checks input[type="checkbox"]').forEach((cb) => {
					cb.checked = state.n0Checks.includes(cb.value);
				});
			}
			// Restore winner radio
			if (state.winner) {
				const radio = $(`input[name="winner"][value="${state.winner}"]`);
				if (radio) radio.checked = true;
			}
			updateRatedPreview();
		}

		return true;
	} catch (e) {
		console.warn('Failed to restore state:', e);
		clearSavedState();
		return false;
	}
}

// --- Event listeners ---

document.addEventListener('DOMContentLoaded', () => {
	$('#names-input').addEventListener('input', countNames);
	$('#btn-randomize').addEventListener('click', doRandomize);
	$('#btn-reroll').addEventListener('click', doRandomize);
	$('#btn-accept').addEventListener('click', acceptAssignments);
	$('#btn-dice').addEventListener('click', async () => {
		const max = parseInt($('#dice-max').value) || 20;
		$('#btn-dice').disabled = true;
		try {
			const res = await fetch('https://api.random.org/json-rpc/4/invoke', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'generateIntegers',
					params: { apiKey: RANDOM_ORG_API_KEY, n: 1, min: 1, max, replacement: true },
					id: 1,
				}),
			});
			const data = await res.json();
			if (data.error) throw new Error(data.error.message);
			$('#dice-result').textContent = data.result.random.data[0];
		} catch (e) {
			$('#dice-result').textContent = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * max) + 1;
		}
		$('#btn-dice').disabled = false;
	});
	$('#btn-back').addEventListener('click', () => showPanel('panel-game'));
	$('#btn-submit').addEventListener('click', submitResults);
	$('#btn-new-game').addEventListener('click', newGame);
	$('#btn-new-game-2').addEventListener('click', async () => {
		if (await confirmAction('Discard current game and start fresh?')) newGame();
	});
	$('#btn-new-game-3').addEventListener('click', async () => {
		if (await confirmAction('Discard current game and start fresh?')) newGame();
	});
	$('#btn-continue-record').addEventListener('click', continueToRecord);
	$('.container').addEventListener('click', handleCopyClick);
	$('#btn-undo-last')?.addEventListener('click', undoLastGame);

	$$('input[name="winner"]').forEach((r) => {
		r.addEventListener('change', () => {
			updateRatedPreview();
			saveState();
		});
	});

	// Manual Setup
	$('#btn-manual').addEventListener('click', doManualSetup);
	$('#btn-manual-cancel').addEventListener('click', () => {
		$('#manual-setup').classList.add('hidden');
		gameMode = 'randomize';
		manualRoleMap = new Map();
		saveState();
	});
	$('#btn-manual-accept').addEventListener('click', acceptManualSetup);

	// Retroactive Entry
	$('#btn-retro').addEventListener('click', doRetroEntry);
	$('#btn-retro-cancel').addEventListener('click', () => {
		$('#retro-form').classList.add('hidden');
		gameMode = 'randomize';
		retroRoleMap = new Map();
		retroNames = [];
		saveState();
	});
	$('#btn-retro-submit').addEventListener('click', submitRetroGame);
	$$('input[name="retro-winner"]').forEach((r) => {
		r.addEventListener('change', () => {
			updateRetroForm();
			saveState();
		});
	});

	// Dark Stars
	$('#btn-darkstars').addEventListener('click', async () => {
		await fillRandomPool(50);
		doDarkStarsSetup();
	});
	$('#btn-darkstars-cancel').addEventListener('click', () => {
		$('#darkstars-setup').classList.add('hidden');
		gameMode = 'randomize';
		gameVariant = 'allstars';
		darkStarsSetup = null;
		currentAssignments = null;
		saveState();
	});
	$('#btn-darkstars-reroll').addEventListener('click', rerollDarkStarsSetup);
	$('#btn-darkstars-accept').addEventListener('click', acceptDarkStarsSetup);

	loadPlayerNames().then(async () => {
		const restored = await restoreState();
		if (!restored) loadLastGame();
	});
});
