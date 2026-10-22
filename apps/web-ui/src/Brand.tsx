import mark from './assets/delivery/lmti-mark.png';

/** The generated mark is decorative; live text keeps the brand crisp and accessible. */
export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return <span className={`brand${compact ? ' brand--compact' : ''}${className ? ` ${className}` : ''}`}>
    <img className="brand-mark" src={mark} alt="" aria-hidden="true" width={40} height={40} draggable={false} />
    <span className="brand-wordmark"><span className="brand-name">LMTi</span>{!compact && <small>STUDIO</small>}</span>
  </span>;
}
