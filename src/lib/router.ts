import { useEffect, useState } from 'react';

function current() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { parts: (path || 'home').split('/').map(decodeURIComponent), query };
}

export function useHashRoute(): string[] {
  const [route, setRoute] = useState(() => current().parts);
  useEffect(() => {
    const on = () => setRoute(current().parts);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function hashParams(): URLSearchParams {
  return new URLSearchParams(current().query);
}

export function navigate(path: string) {
  window.location.hash = '#/' + path.replace(/^\//, '');
}
