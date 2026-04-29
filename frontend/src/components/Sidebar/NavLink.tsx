import { A } from '@solidjs/router';
import type { JSX } from 'solid-js';
import { fireNavClick } from '../../store/navStore';

export function NavLink(props: { to: string; icon: JSX.Element; children: JSX.Element }) {
  return (
    <A
      href={props.to}
      class="nav-link"
      activeClass="active"
      end={props.to === '/'}
      onClick={() => fireNavClick(props.to)}
    >
      {props.icon}
      <span>{props.children}</span>
    </A>
  );
}
