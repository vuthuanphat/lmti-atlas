import overview from './assets/delivery/overview.png';
import work from './assets/delivery/work.png';
import architecture from './assets/delivery/architecture.png';
import knowledge from './assets/delivery/knowledge.png';
import agent from './assets/delivery/agent.png';
import connection from './assets/delivery/connection.png';
import project from './assets/delivery/project.png';
import activity from './assets/delivery/activity.png';

const sources = { overview, work, architecture, knowledge, agent, connection, project, activity };
export type IconName = keyof typeof sources;

/** Publisher-owned Image AI artwork. Labels always belong to the surrounding control. */
export function Icon({ name, size = 24, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <img className={`ui-icon ${className}`} src={sources[name]} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async" />;
}
