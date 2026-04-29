import { render } from 'solid-js/web';
import App from './App';
import './styles/variables.css';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

render(() => <App />, root);
