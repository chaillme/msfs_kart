import type { RaceResult } from '@shared/session';

function fmt(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '–';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** End-of-race classification table (updates live until everyone has finished). */
export class ResultsUi {
  visible = false;
  private lastKey = '';

  constructor(private readonly root: HTMLElement) {}

  show(results: RaceResult[], playerId: string, final: boolean): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    const key = results.map((r) => `${r.id}:${r.position}:${r.estimated ? 'e' : r.time.toFixed(2)}`).join('|') + final;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const winner = results[0];
    const rows = results
      .map((r) => {
        const gap = r.position === 1 ? '' : `+${(r.time - winner.time).toFixed(2)} s`;
        const time = r.estimated ? (final ? `≈ ${fmt(r.time)}` : 'en course…') : fmt(r.time);
        const medal = r.position <= 3 ? ` medal m${r.position}` : '';
        return `<tr class="${r.id === playerId ? 'me' : ''}${medal}">
          <td class="pos">${r.position}</td>
          <td class="name"><i style="background:${r.color}"></i>${esc(r.name)}</td>
          <td class="time">${time}</td>
          <td class="gap">${r.estimated && !final ? '' : gap}</td>
          <td class="best">${fmt(r.bestLap)}</td>
        </tr>`;
      })
      .join('');
    this.root.innerHTML = `
      <div class="panel">
        <h2>Classement</h2>
        <table>
          <thead><tr><th>#</th><th>Pilote</th><th>Temps</th><th>Écart</th><th>Meilleur tour</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint">${final ? '' : 'Les autres pilotes terminent leur course… · '}<kbd>Entrée</kbd> rejouer</p>
      </div>`;
  }

  /** Replace the footer line (e.g. online: host / waiting message). */
  setHint(html: string): void {
    const p = this.root.querySelector('.hint');
    if (p) p.innerHTML = html;
  }

  hide(): void {
    this.visible = false;
    this.lastKey = '';
    this.root.classList.add('hidden');
  }
}
