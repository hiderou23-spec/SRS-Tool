import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useHashRoute } from './lib/router';
import { useSettings, useToast } from './lib/hooks';
import { requestPersistentStorage } from './db/db';
import { IconHome, IconLibrary, IconProgress, IconSettings, IconStudy } from './components/Icons';
import Home from './pages/Home';
import Study from './pages/Study';
import Library from './pages/Library';
import ExpressionDetail from './pages/ExpressionDetail';
import Progress from './pages/Progress';
import SettingsPage from './pages/Settings';
import ImportPage from './pages/Import';
import Duplicates from './pages/Duplicates';
import Backlog from './pages/Backlog';

const TABS = [
  { key: 'home', label: 'Home', Icon: IconHome },
  { key: 'study', label: 'Study', Icon: IconStudy },
  { key: 'library', label: 'Library', Icon: IconLibrary },
  { key: 'progress', label: 'Progress', Icon: IconProgress },
  { key: 'settings', label: 'Settings', Icon: IconSettings },
];

export default function App() {
  const route = useHashRoute();
  const settings = useSettings();
  const toastMsg = useToast();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  const [top, a1] = route;
  let page;
  switch (top) {
    case 'study': page = <Study />; break;
    case 'library': page = a1 ? <ExpressionDetail id={a1} /> : <Library />; break;
    case 'progress': page = <Progress />; break;
    case 'settings': page = <SettingsPage />; break;
    case 'import': page = <ImportPage />; break;
    case 'duplicates': page = <Duplicates />; break;
    case 'backlog': page = <Backlog />; break;
    default: page = <Home />;
  }
  const activeTab = ['import', 'duplicates', 'backlog'].includes(top) ? 'settings' : top;

  return (
    <div className="app">
      {needRefresh && (
        <div className="notice info" style={{ margin: 'calc(env(safe-area-inset-top) + 8px) 16px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="grow">新しいバージョンがあります</span>
          <button className="btn sm primary" onClick={() => updateServiceWorker(true)}>更新</button>
        </div>
      )}
      {page}
      {top !== 'study' && (
        <nav className="tabbar" aria-label="メイン">
          {TABS.map(({ key, label, Icon }) => (
            <a key={key} className="tab" href={`#/${key}`} aria-current={activeTab === key || (key === 'home' && !TABS.some((t) => t.key === activeTab)) ? 'page' : undefined}>
              <Icon />
              {label}
            </a>
          ))}
        </nav>
      )}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
