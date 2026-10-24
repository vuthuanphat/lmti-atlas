import { translate, type Language } from './i18n';
import type { SessionEndReason } from './session-lifecycle';

export function SessionGuidance({ reason, language }: { reason: SessionEndReason; language: Language }) {
  const t = (text: string) => translate(language, text);
  const title = reason === 'startup_network' ? 'Local service could not be reached' :
    reason === 'startup_refused' ? 'Private session could not start' :
    reason === 'expired' ? 'Private session expired' :
    reason === 'unauthenticated' ? 'A fresh private session is required' : 'Private session ended';
  return <section className="empty" aria-labelledby="session-guidance-title">
    <h1 id="session-guidance-title">{t(title)}</h1>
    {reason === 'startup_network' && <p>{t('The launcher service stopped or could not be contacted. This does not mean your project data was lost.')}</p>}
    {reason === 'startup_refused' && <p>{t('The local service refused to start this session. Check the operator console before opening a fresh session.')}</p>}
    <p>{t('Run Open-LMTI.cmd in your prepared workspace. Keep its operator console open; press O there to open a fresh private browser session.')}</p>
    <p>{t('An old browser tab or a page refresh cannot create a new private session. Do not reuse or share a launch link.')}</p>
    <p>{t('If an operation was interrupted, inspect its status and recovery in Work before another change. Do not repeat the submitted operation.')}</p>
  </section>;
}

export function ServiceConnectionBanner({ language, checking, onCheck }: {
  language: Language; checking: boolean; onCheck: () => void;
}) {
  const t = (text: string) => translate(language, text);
  return <section className="notice error-notice" role="alert" aria-label={t('Local service connection')}>
    <strong>{t('Local service could not be reached')}</strong>
    <p>{t('Keep the Open-LMTI.cmd operator console running. If it stopped, run it again and press O for a fresh private session.')}</p>
    <p>{t('A connection check only reads service status. It does not repeat a write or clear a recovery requirement.')}</p>
    <button type="button" disabled={checking} onClick={onCheck}>{t(checking ? 'Checking connection…' : 'Check service connection')}</button>
  </section>;
}
