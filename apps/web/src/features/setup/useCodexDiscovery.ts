import { useCallback, useEffect, useRef, useState } from 'react';
import { api, json } from '../../api/client';
import type { CodexDiscovery, CodexDiscoveryImportInput, CodexDiscoveryImportResult } from '../../api/types';

export function useCodexDiscovery(afterImport?: (result: CodexDiscoveryImportResult) => Promise<unknown>, options: { reconfigure?: boolean } = {}) {
  const [data, setData] = useState<CodexDiscovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const afterImportRef = useRef(afterImport);
  afterImportRef.current = afterImport;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setData(await api<CodexDiscovery>('/codex/discovery')); }
    catch (value) { setError(message(value)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const importConfig = useCallback(async (input: CodexDiscoveryImportInput) => {
    setBusy(true);
    setActionError('');
    try {
      const result = await api<CodexDiscoveryImportResult>('/codex/discovery/import', json('POST', { ...input, ...(options.reconfigure ? { reconfigure: true } : {}) }, '导入 Codex 配置'));
      await Promise.all([refresh(), afterImportRef.current?.(result)]);
      return result;
    } catch (value) { setActionError(message(value)); return undefined; }
    finally { setBusy(false); }
  }, [options.reconfigure, refresh]);

  return { data, loading, busy, error, actionError, refresh, importConfig };
}

function message(value: unknown) { return value instanceof Error ? value.message : '本地配置导入失败'; }
