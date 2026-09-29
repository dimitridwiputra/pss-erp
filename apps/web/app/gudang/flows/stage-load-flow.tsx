'use client';

import type { PackStageLoadOutcomeResponse } from '@pss/contracts';
import { Button, MobileTaskTemplate, ScanScreen, TextField, Toast } from '@pss/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { GudangApiError, gudangFetch, newIdempotencyKey } from '../lib/api-client';

/** WMS-008 (stage) + WMS-009 (load): scan one koli at a time into a lane, then onto a vehicle. */
export function StageLoadFlow({ switchModeAction }: { switchModeAction: ReactNode }) {
  const [unitCode, setUnitCode] = useState('');
  const [laneCode, setLaneCode] = useState('');
  const [vehicleCode, setVehicleCode] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const stage = useMutation({
    mutationFn: () => gudangFetch<PackStageLoadOutcomeResponse>('/gudang/stage', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ unitCode, laneCode }),
    }),
    onSuccess: (result) => { setFeedback(result.completed ? 'Staging selesai untuk referensi ini' : 'Koli ter-stage'); setUnitCode(''); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal staging.'),
  });

  const load = useMutation({
    mutationFn: () => gudangFetch<PackStageLoadOutcomeResponse>('/gudang/load', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: JSON.stringify({ unitCode, vehicleCode }),
    }),
    onSuccess: (result) => { setFeedback(result.completed ? 'Muat selesai untuk lajur ini' : 'Koli dimuat'); setUnitCode(''); },
    onError: (error: unknown) => setFeedback(error instanceof GudangApiError ? error.problem.message : 'Gagal memuat.'),
  });

  return (
    <MobileTaskTemplate
      context="Stage & Load"
      instruction="Scan koli, lalu lajur atau kendaraan"
      object={
        <ScanScreen title="Scan Koli" target="Pindai label koli" instruction="Cocokkan dengan label koli"
          code={unitCode} onCodeChange={setUnitCode} onSubmitCode={() => {}} />
      }
      details={
        <>
          <TextField id="lane-code" label="Kode Lajur (Stage)" value={laneCode} onChange={(event) => setLaneCode(event.target.value)} />
          <Button label="Stage" state={stage.isPending ? 'loading' : 'default'} disabled={!unitCode || !laneCode} onClick={() => stage.mutate()} />
          <TextField id="vehicle-code" label="Kode Kendaraan (Load)" value={vehicleCode} onChange={(event) => setVehicleCode(event.target.value)} />
          <Button label="Load" tone="secondary" state={load.isPending ? 'loading' : 'default'} disabled={!unitCode || !vehicleCode} onClick={() => load.mutate()} />
          {switchModeAction}
        </>
      }
      feedback={feedback ? <Toast message={feedback} tone={stage.isError || load.isError ? 'danger' : 'success'} /> : undefined}
      action={undefined}
    />
  );
}
