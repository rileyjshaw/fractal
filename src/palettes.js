// Pulled from https://lospec.com/palette-list using the following snippet:
//
// function componentToHex(c) {
//   return ('0' + c.toString(16)).slice(-2);
// }
// function rgbToHex(str) {
//   const [r, g, b] = str.match(/\d+/g).map(Number);
//   return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
// }
// Array.from(document.querySelectorAll('div.palette')).map(container => {
//   return Array.from(container.querySelectorAll('div.color')).map(el => rgbToHex(el.style.background));
// });

// Entering a new color? Find a usable ID with:
//
// const unambiguousChars = ['c', 'd', 'e', 'f', 'h', 'j', 'k', 'm', 'n', 'p', 'r', 't', 'v', 'w', 'x', 'y', '2', '3', '4', '5', '6', '8', '9']
// let id;
// do {
//   id = Array.from({length: 3}, () => unambiguousChars[Math.floor(Math.random() * unambiguousChars.length)]).join('');
// } while (id in palettes)

import rawPalettes from './rawPalettes.json';
import { shuffleArray } from './util.js';

const starterIds = [
	'266',
	'wpt',
	'h2y',
	'45j',
	'myj',
	'h66',
	'emw',
	'y54',
	'frf',
	'8rd',
	'kn4',
	'm68',
	'v6t',
	'xtm',
	'x6t',
	'kec',
];
const starterIdSet = new Set(starterIds);
const otherIds = Object.keys(rawPalettes).filter(id => !starterIdSet.has(id));

shuffleArray(starterIds);
shuffleArray(otherIds);

export const paletteIds = [...starterIds, ...otherIds];

export default rawPalettes;
