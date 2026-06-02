// Generates unique, human-friendly two-word client names (e.g. "Brave Otter")
// along with a stable color, used to label remote cursors.

const ADJECTIVES = [
	"Brave", "Calm", "Clever", "Cosmic", "Crimson", "Dapper", "Eager", "Electric",
	"Fancy", "Fuzzy", "Gentle", "Golden", "Happy", "Jolly", "Lucky", "Mellow",
	"Mighty", "Nimble", "Noble", "Plucky", "Quiet", "Rapid", "Rusty", "Sage",
	"Shiny", "Silly", "Sly", "Snappy", "Solar", "Spry", "Sunny", "Swift",
	"Tidy", "Vivid", "Witty", "Zesty",
];

const ANIMALS = [
	"Otter", "Falcon", "Badger", "Lynx", "Heron", "Marmot", "Panda", "Raven",
	"Wombat", "Ferret", "Gecko", "Ibex", "Jackal", "Koala", "Lemur", "Manta",
	"Newt", "Ocelot", "Puffin", "Quokka", "Robin", "Stoat", "Tapir", "Urchin",
	"Viper", "Walrus", "Yak", "Zebra", "Mole", "Finch", "Hare", "Crane",
];

// A pleasant, high-contrast palette for cursor colors.
const COLORS = [
	"#e6194b", "#3cb44b", "#f58231", "#4363d8", "#911eb4", "#46f0f0",
	"#f032e6", "#bcf60c", "#fabebe", "#008080", "#9a6324", "#800000",
	"#808000", "#000075", "#e6beff", "#aaffc3", "#ffd8b1", "#808080",
];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export interface ClientIdentity {
	name: string;
	color: string;
	/** A translucent variant of `color`, used for selection highlights. */
	colorLight: string;
}

export function generateClientIdentity(): ClientIdentity {
	const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
	const color = pick(COLORS);
	return { name, color, colorLight: color + "33" };
}
