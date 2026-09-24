'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export type Feature = {
  id: string;
  name: string;
  phase: string;
  priority: string;
  pod: string;
  sprint: string;
  dependencies: string[];
  user: string;
  outcome: string;
  state: 'available' | 'partial' | 'planned';
  availablePath?: string;
  note?: string;
};

const stateLabels = {
  available: 'Fondasi tersedia',
  partial: 'Sebagian dibangun',
  planned: 'Dalam rencana',
} as const;

export function FeatureDirectory({ features }: { features: Feature[] }) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState('all');
  const [state, setState] = useState('all');

  const phases = useMemo(() => [...new Set(features.map((feature) => feature.phase))]
    .sort((first, second) => Number(first.slice(1)) - Number(second.slice(1))), [features]);

  const counts = useMemo(() => ({
    available: features.filter((feature) => feature.state === 'available').length,
    partial: features.filter((feature) => feature.state === 'partial').length,
    planned: features.filter((feature) => feature.state === 'planned').length,
  }), [features]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('id-ID');
    return features.filter((feature) => {
      if (phase !== 'all' && feature.phase !== phase) return false;
      if (state !== 'all' && feature.state !== state) return false;
      if (!normalizedQuery) return true;
      return [feature.id, feature.name, feature.outcome, feature.user, feature.pod]
        .some((value) => value.toLocaleLowerCase('id-ID').includes(normalizedQuery));
    });
  }, [features, phase, query, state]);

  return (
    <section className="directory-body" aria-label="Direktori fitur">
      <div className="directory-overview" aria-label="Ringkasan status">
        <div><span>Total direncanakan</span><strong>{features.length}</strong><small>Fitur dalam PRD</small></div>
        <div><span>Fondasi tersedia</span><strong>{counts.available}</strong><small>Layar yang bisa dibuka</small></div>
        <div><span>Sebagian dibangun</span><strong>{counts.partial}</strong><small>Belum siap digunakan</small></div>
        <div><span>Dalam rencana</span><strong>{counts.planned}</strong><small>Belum ada layar kerja</small></div>
      </div>

      <div className="directory-content">
        <aside className="directory-aside" aria-label="Panduan status">
          <p className="directory-aside-label">CARA MEMBACA</p>
          <h2>Satu daftar, status yang jelas.</h2>
          <p><strong>Fondasi tersedia</strong> berarti ada halaman atau pemeriksaan yang bisa dibuka sekarang. Ini belum berarti ERP siap transaksi.</p>
          <p><strong>Sebagian dibangun</strong> berarti kontrak, layanan, atau elemen UI telah dimulai namun alurnya belum lengkap.</p>
          <p><strong>Dalam rencana</strong> berarti fitur baru tercantum di PRD dan belum tersedia sebagai layar kerja.</p>
          <div className="directory-aside-note">Setiap transaksi nanti memerlukan akses, audit, dan aturan bisnis yang sudah disetujui.</div>
        </aside>

        <div className="directory-main">
          <div className="directory-list-heading">
            <div><p className="directory-eyebrow">DAFTAR FITUR</p><h2>Temukan pekerjaan yang ingin dilihat</h2></div>
            <span>{filtered.length} dari {features.length} fitur</span>
          </div>
          <div className="directory-filters">
            <label className="directory-search">
              <span>Cari fitur</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama, kode, atau pekerjaan…" />
            </label>
            <label>
              <span>Fase</span>
              <select value={phase} onChange={(event) => setPhase(event.target.value)}>
                <option value="all">Semua fase</option>
                {phases.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={state} onChange={(event) => setState(event.target.value)}>
                <option value="all">Semua status</option>
                <option value="available">Fondasi tersedia</option>
                <option value="partial">Sebagian dibangun</option>
                <option value="planned">Dalam rencana</option>
              </select>
            </label>
          </div>

          {filtered.length === 0 ? (
            <div className="directory-empty">
              <h3>Tidak ada fitur yang cocok</h3>
              <p>Coba kata lain atau tampilkan seluruh fase dan status.</p>
              <button type="button" onClick={() => { setQuery(''); setPhase('all'); setState('all'); }}>Tampilkan semua fitur</button>
            </div>
          ) : (
            <ol className="feature-list">
              {filtered.map((feature) => (
                <li key={feature.id} className="feature-card">
                  <div className="feature-topline">
                    <span className="feature-id">{feature.id}</span>
                    <span className={`feature-state feature-state-${feature.state}`}>{stateLabels[feature.state]}</span>
                  </div>
                  <h3>{feature.name}</h3>
                  <p className="feature-outcome">{feature.outcome}</p>
                  <div className="feature-meta">
                    <span>{feature.phase} · {feature.sprint}</span>
                    <span>{feature.pod}</span>
                  </div>
                  {feature.note && <p className="feature-note">{feature.note}</p>}
                  {feature.availablePath && <Link className="feature-link" href={feature.availablePath}>Buka layar fondasi <span aria-hidden="true">→</span></Link>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
