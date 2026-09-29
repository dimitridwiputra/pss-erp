'use client';

import { openWmsOfflineDatabase, syncWmsOfflineBatch } from '@pss/offline';
import { Button, TextField } from '@pss/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useOnlineStatus } from './hooks/use-online-status';
import { newIdempotencyKey } from './lib/api-client';
import { PickFlow } from './flows/pick-flow';
import { PutawayFlow } from './flows/putaway-flow';
import { ReceiveFlow } from './flows/receive-flow';
import { CountFlow } from './flows/count-flow';
import { PackFlow } from './flows/pack-flow';
import { StageLoadFlow } from './flows/stage-load-flow';
import { DashboardFlow } from './flows/dashboard-flow';

type Mode = 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'COUNT' | 'PACK' | 'STAGE_LOAD' | 'DASHBOARD';

const MODES: Array<{ value: Mode; label: string; details: string }> = [
  { value: 'PICK', label: 'Pick', details: 'Ambil barang untuk pengiriman' },
  { value: 'PUTAWAY', label: 'Putaway', details: 'Simpan barang ke lokasi' },
  { value: 'RECEIVE', label: 'Terima', details: 'Terima barang masuk' },
  { value: 'COUNT', label: 'Hitung', details: 'Hitung stok lokasi (buta)' },
  { value: 'PACK', label: 'Pack', details: 'Kemas barang hasil pick' },
  { value: 'STAGE_LOAD', label: 'Stage & Load', details: 'Susun ke lajur & muat kendaraan' },
  { value: 'DASHBOARD', label: 'Dashboard', details: 'Ringkasan gudang (supervisor)' },
];

export function GudangTugas() {
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [warehouseId, setWarehouseId] = useState('');
  const [mode, setMode] = useState<Mode | null>(null);

  // WMS-014: as soon as connectivity returns, flush any confirmations queued while offline.
  useEffect(() => {
    if (!online) return;
    void (async () => {
      const result = await syncWmsOfflineBatch(openWmsOfflineDatabase(), {
        endpoint: '/gudang/sync', idempotencyKey: newIdempotencyKey(),
      }).catch(() => null);
      if (result) await queryClient.invalidateQueries({ queryKey: ['gudang-next-task'] });
    })();
  }, [online, queryClient]);

  if (!warehouseId || !mode) {
    return (
      <main className="pss-page-template pss-mobile-task">
        <header className="pss-template-header"><p className="pss-template-eyebrow">PSS Gudang</p><h1>Mulai Kerja</h1></header>
        <section className="pss-template-panel">
          <TextField id="warehouse-id" label="ID Gudang" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required />
          <div className="pss-gudang-mode-grid">
            {MODES.map((option) => (
              <Button key={option.value} label={option.label} tone={mode === option.value ? 'primary' : 'secondary'}
                disabled={!warehouseId} onClick={() => setMode(option.value)} />
            ))}
          </div>
        </section>
      </main>
    );
  }

  const back = <Button label="Ganti Tugas" tone="secondary" onClick={() => setMode(null)} />;

  switch (mode) {
    case 'PICK': return <PickFlow warehouseId={warehouseId} switchModeAction={back} />;
    case 'PUTAWAY': return <PutawayFlow warehouseId={warehouseId} switchModeAction={back} />;
    case 'RECEIVE': return <ReceiveFlow warehouseId={warehouseId} switchModeAction={back} />;
    case 'COUNT': return <CountFlow warehouseId={warehouseId} switchModeAction={back} />;
    case 'PACK': return <PackFlow warehouseId={warehouseId} switchModeAction={back} />;
    case 'STAGE_LOAD': return <StageLoadFlow switchModeAction={back} />;
    case 'DASHBOARD': return <DashboardFlow warehouseId={warehouseId} switchModeAction={back} />;
  }
}
