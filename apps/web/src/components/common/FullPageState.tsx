import { LoaderCircle, RefreshCw } from 'lucide-react';

export function FullPageState({ title, detail, retry }: { title: string; detail?: string; retry?: () => void }) {
  return (
    <main className="full-state">
      <LoaderCircle className="spin" aria-hidden />
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
      {retry && <button className="button secondary" onClick={retry}><RefreshCw size={16} />重试</button>}
    </main>
  );
}
