/* Mafia Match History — fetches from Cloud Function getMatchHistory action */

const SCRIPT_URL = (typeof window !== 'undefined' && window.SCRIPT_URL !== undefined)
	? window.SCRIPT_URL
	: 'https://us-central1-mafia-tracker-310960.cloudfunctions.net/mafia-backend';

const $ = (sel) => document.querySelector(sel);

function showToast(msg) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function api(action, data = {}) {
	if (!SCRIPT_URL) throw new Error('Backend not configured for this site');
	const resp = await fetch(SCRIPT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...data }),
	});
	const result = await resp.json();
	if (result.error) throw new Error(result.error);
	return result;
}

async function loadGames() {
	try {
		const data = await api('getMatchHistory');
		renderGames(data.games || []);
	} catch (e) {
		showToast('Failed to load match history: ' + e.message);
	}
}

function renderGames(games) {
	const container = $('#games-list');
	container.innerHTML = '';

	if (!games.length) {
		container.innerHTML = '<p style="color: var(--text-muted)">No games yet.</p>';
		return;
	}

	for (const g of games) {
		const card = document.createElement('div');
		card.className = 'game-card';

		const winner = (g.winner || '').toLowerCase();
		const winnerClass = winner === 'mafia' ? 'mafia' : 'town';
		const winnerLabel = g.winner ? `${escapeHtml(g.winner)} Win` : '—';

		const mafiaPills = g.mafia
			.map((n) => `<span class="player-pill mafia">${escapeHtml(n)}</span>`)
			.join(' ');
		const townPills = g.town
			.map((t) => `<span class="player-pill town">${escapeHtml(t.name)}</span>`)
			.join(' ');

		let extra = '';
		if (g.n0 && g.n0.length) {
			const pills = g.n0.map((n) => `<span class="player-pill">${escapeHtml(n)}</span>`).join(' ');
			extra += `<div class="game-card-row"><span class="game-card-label">N0</span>${pills}</div>`;
		}
		if (g.ghosts && g.ghosts.length) {
			const pills = g.ghosts.map((n) => `<span class="player-pill">${escapeHtml(n)}</span>`).join(' ');
			extra += `<div class="game-card-row"><span class="game-card-label">Ghosts</span>${pills}</div>`;
		}

		card.innerHTML = `
			<div class="game-card-header">
				<span class="game-card-id">Game ${g.game_id}</span>
				<span class="game-card-winner ${winnerClass}">${winnerLabel}</span>
			</div>
			<div class="game-card-row"><span class="game-card-label">Mafia</span>${mafiaPills}</div>
			<div class="game-card-row"><span class="game-card-label">Town</span>${townPills}</div>
			${extra}
		`;
		container.appendChild(card);
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

document.addEventListener('DOMContentLoaded', loadGames);
