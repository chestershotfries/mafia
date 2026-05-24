/* Ego Mafia Stats — leaderboard, summary, player detail.
 * Reads window.SCRIPT_URL when set (Cloud Function), else ./data.json. */

let statsData = null;
let currentSort = { key: 'rating', desc: true };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showToast(msg) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function api(action, data = {}) {
	const resp = await fetch(window.SCRIPT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...data }),
	});
	const result = await resp.json();
	if (result.error) throw new Error(result.error);
	return result;
}

function roleAlignmentClass(role) {
	if (role === 'Mafia') return 'align-mafia';
	if (role === 'Cop') return 'role-cop';
	if (role === 'Medic') return 'role-medic';
	if (role === 'Vigilante') return 'role-vig';
	return 'align-town';
}

function buildHistoryMap(games) {
	const history = {};
	for (const g of games || []) {
		for (const p of g.players || []) {
			const entry = {
				game_id: g.game_id,
				alignment: p.role || p.alignment || 'Town',
				result: p.result,
				rate_change: p.rate_change,
			};
			if (p.old_rating !== undefined) {
				entry.old_rating = p.old_rating;
				entry.new_rating = p.new_rating;
			}
			(history[p.player] = history[p.player] || []).push(entry);
		}
	}
	return history;
}

async function loadStats() {
	try {
		if (window.SCRIPT_URL) {
			const [stats, mh] = await Promise.all([
				api('getStats'),
				api('getMatchHistory'),
			]);
			statsData = {
				players: stats.players,
				game_summary: stats.game_summary,
				history: buildHistoryMap(mh.games),
			};
		} else {
			const resp = await fetch('./data.json', { cache: 'no-cache' });
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			statsData = await resp.json();
			if (statsData.games) {
				statsData.history = buildHistoryMap(statsData.games);
			}
		}
		renderStatsSummary(statsData.game_summary);
		renderLeaderboard(statsData.players);
	} catch (e) {
		showToast('Failed to load stats: ' + e.message);
	}
}

function renderStatsSummary(summary) {
	$('#stat-total-games').textContent = summary.total_games;
	$('#stat-mafia-pct').textContent = summary.mafia_win_pct + '%';
	$('#stat-town-pct').textContent = summary.town_win_pct + '%';
}

function winPctStyle(pct) {
	const t = pct / 100;
	if (t >= 0.5) {
		const s = (t - 0.5) * 2;
		const r = Math.round(153 - s * 79);
		const g = Math.round(153 + s * 4);
		const b = Math.round(153 - s * 42);
		return `style="color: rgb(${r},${g},${b})"`;
	} else {
		const s = t * 2;
		const r = Math.round(211 - s * 58);
		const g = Math.round(47 + s * 106);
		const b = Math.round(47 + s * 106);
		return `style="color: rgb(${r},${g},${b})"`;
	}
}

function renderLeaderboard(players) {
	const byRating = [...players].sort((a, b) => b.rating - a.rating);
	const rankMap = new Map();
	byRating.forEach((p, i) => rankMap.set(p.name, i + 1));

	const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
	const rankClass = (r) => {
		if (r === 1) return 'rank-gold';
		if (r === 2) return 'rank-silver';
		if (r === 3) return 'rank-bronze';
		if (r <= 15) return 'rank-top15';
		return '';
	};

	const sorted = [...players].sort((a, b) => {
		const aVal = a[currentSort.key];
		const bVal = b[currentSort.key];
		if (currentSort.key === 'name') {
			return currentSort.desc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
		}
		return currentSort.desc ? bVal - aVal : aVal - bVal;
	});

	const tbody = $('#stats-tbody');
	tbody.innerHTML = '';

	for (const p of sorted) {
		const rank = rankMap.get(p.name);
		const tr = document.createElement('tr');
		tr.dataset.player = p.name;
		const nameClass = rank <= 3 ? rankClass(rank) : '';
		tr.innerHTML = `
			<td class="${rankClass(rank)}">${medals[rank] || rank}</td>
			<td class="${nameClass}">${escapeHtml(p.name)}</td>
			<td>${p.rating}</td>
			<td>${p.total_games}</td>
			<td ${winPctStyle(p.total_win_pct)}>${p.total_win_pct}%</td>
			<td>${p.mafia_games}</td>
			<td ${winPctStyle(p.mafia_win_pct)}>${p.mafia_win_pct}%</td>
			<td>${p.town_games}</td>
			<td ${winPctStyle(p.town_win_pct)}>${p.town_win_pct}%</td>
		`;
		tr.addEventListener('click', () => showPlayerDetail(p.name));
		tbody.appendChild(tr);
	}

	$$('#stats-table th').forEach((th) => {
		th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
		if (th.dataset.sort === currentSort.key) {
			th.classList.add('sort-active');
			th.classList.add(currentSort.desc ? 'sort-desc' : 'sort-asc');
		}
	});
}

function showPlayerDetail(playerName) {
	const detailPanel = $('#player-detail');
	const tbody = $('#detail-tbody');

	$$('#stats-tbody tr').forEach((tr) => {
		tr.classList.toggle('selected', tr.dataset.player === playerName);
	});

	$('#detail-player-name').textContent = playerName;
	detailPanel.classList.remove('hidden');
	tbody.innerHTML = '';

	const games = (statsData.history[playerName] || []);
	for (const g of games) {
		const tr = document.createElement('tr');
		const alignClass = roleAlignmentClass(g.alignment);
		const isExcluded = g.result === 'Ghost' || g.result === 'Night Zero';
		const ratingDisplay = g.old_rating !== undefined
			? `${g.old_rating} → ${g.new_rating}`
			: '-';
		const changeClass = g.rate_change >= 0 ? 'change-pos' : 'change-neg';
		const sign = g.rate_change >= 0 ? '+' : '';

		tr.innerHTML = `
			<td>#${g.game_id}</td>
			<td class="${alignClass}">${g.alignment}</td>
			<td>${g.result}</td>
			<td>${ratingDisplay}</td>
			<td class="${isExcluded ? '' : changeClass}">${isExcluded ? '-' : sign + g.rate_change}</td>
		`;
		if (isExcluded) tr.classList.add('excluded-row');
		tbody.appendChild(tr);
	}
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[c]));
}

document.addEventListener('DOMContentLoaded', () => {
	$$('#stats-table th[data-sort]').forEach((th) => {
		th.addEventListener('click', () => {
			const key = th.dataset.sort;
			if (currentSort.key === key) {
				currentSort.desc = !currentSort.desc;
			} else {
				currentSort.key = key;
				currentSort.desc = key !== 'name';
			}
			if (statsData) renderLeaderboard(statsData.players);
		});
	});

	$('#btn-close-detail').addEventListener('click', () => {
		$('#player-detail').classList.add('hidden');
		$$('#stats-tbody tr').forEach((tr) => tr.classList.remove('selected'));
	});

	loadStats();
});
