import { useEffect, useState } from 'react';

export function useCompactViewport() {
  const [compact, setCompact] = useState(() => window.matchMedia?.('(max-width: 700px)').matches || false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)'),
      change = () => setCompact(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return compact;
}
