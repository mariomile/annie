import { addTo, ageOn, DateError, dayOfYear, dueDates, FIRST_YEAR, inRange, isoWeek, LAST_YEAR, parseDate, parseDayMonth, parseMonth, span, UNITS, type Unit, workingDaysIn } from "../dates.ts";
import type { AnnieTool } from "../engine.ts";
import { daysBetween, daysInMonth, type Holiday, holidayOn, isoDate, italianHolidays, leapYear, todayIn, weekdayOf, type WorkingWeek, workingDay } from "../italian-calendar.ts";
import { capitalized, italianDate, italianWeekday } from "../italian-format.ts";

export type DateToolsOptions = {
	/** The server's time zone (ANNIE_TIME_ZONE): where "today" is. */
	readonly timeZone: string;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const OPS = ["info", "between", "add", "due", "working_days", "holidays", "age"] as const;
type Op = (typeof OPS)[number];
const MAX_TEXT = 60;
const MAX_INSTALMENTS = 12;
const MAX_DUE_DAYS = 720;
/** Holidays listed one by one in an answer; beyond, only how many. */
const MAX_LISTED = 15;
const MONTH_NAMES = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const UNIT_WORDS: Readonly<Record<Unit, readonly [string, string]>> = {
	days: ["giorno", "giorni"],
	working_days: ["giorno lavorativo", "giorni lavorativi"],
	weeks: ["settimana", "settimane"],
	months: ["mese", "mesi"],
	years: ["anno", "anni"],
};

/**
 * Calendar arithmetic, which language models get wrong: what day a date falls on, days and
 * working days between dates, adding to a date, invoice due dates, Italian holidays, ages. Pure
 * and offline (no network, no keys), so always offered and safe in the brief's thread; nothing
 * from outside, so no fence. The rules live in dates.ts and italian-calendar.ts.
 */
export function createDateTools(options: DateToolsOptions): AnnieTool[] {
	const now = options.now ?? (() => new Date());
	return [
		{
			name: "date_calc",
			description:
				"Exact date arithmetic with the Italian calendar: use it for any question about dates, days, deadlines or working days instead of working them out in your head. " +
				"op info: what a date is (weekday, holiday, working day, ISO week, day of the year, how far from today). " +
				"op between: from date (today if not given) to to: calendar days, weeks and days, months and days, working days (by default the starting day is not counted and the last is; inclusive true counts both), and how many days are left or have passed. " +
				"op add: amount (negative to go back) of unit days, working_days, weeks, months or years to date (today if not given); months and years on the 31st land on the last day of a shorter month (31/01 + 1 month = 28/02, 29/02 in leap years), and the answer says so. " +
				"op due: the due dates of an invoice dated date, days 60 or several «30,60,90» (or [30, 60, 90]); «d.f.» (data fattura) = days after the invoice date; «f.m.» (fine mese) = end_of_month true: count the days from the invoice date, then the end of that month (15/10 + 60 gg f.m. = 31/12); fixed_day for a «giorno fisso» = that day of the following month (60 gg f.m. + 10 = the 10th after). A due date on a weekend or holiday is given as it is, with the first working day after. " +
				"op working_days: month («novembre», «novembre 2026», 2026-11) or date to to, both included: working days and the holidays among them. " +
				"op holidays: Italy's national holidays of year (1/1, 6/1, Pasqua, Pasquetta, 25/4, 1/5, 2/6, 15/8, 4/10 from 2026, 1/11, 8/12, 25/12, 26/12). " +
				"op age: birth date → age, next birthday and days left; to gives the age on another day. " +
				"Working days are Monday to Friday minus national holidays; Saturday is not a working day unless saturday_working is true (a shop open on Saturdays). patrono (e.g. 29/06 or «7 dicembre») adds the local patron saint's day: ask or use it when the person's city matters. " +
				"Dates: 2027-03-15, 15/03/2027, 15/3/27, 15/03, «15 marzo 2027», «1° novembre», oggi, domani, ieri, Natale, Capodanno, Epifania, Pasqua, Pasquetta, Ferragosto (with a year if needed: «Pasqua 2030»). " +
				`Without a year a date is its next occurrence (today counts; a to without year comes after date), but for due and age the latest one not in the future; a birth needs the year. Years ${FIRST_YEAR}–${LAST_YEAR}. Today is the server's date. ` +
				"Give the person the dates the tool gives, with their weekday.",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...OPS], description: "What to work out" },
					date: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "The date: of info, the start of between and add (today if not given), the invoice of due, the birth of age, the start of a working_days range" },
					to: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "The end date of between and of a working_days range; the day of an age (today if not given)" },
					amount: { type: "integer", minimum: -100_000, maximum: 100_000, description: "add: how many units, negative to go back" },
					unit: { type: "string", enum: [...UNITS], description: "add: the unit of amount (days if not given)" },
					days: {
						anyOf: [
							{ type: "integer", minimum: 0, maximum: MAX_DUE_DAYS },
							{ type: "string", minLength: 1, maxLength: MAX_TEXT },
							{ type: "array", minItems: 1, maxItems: MAX_INSTALMENTS, items: { type: "integer", minimum: 0, maximum: MAX_DUE_DAYS } },
						],
						description: "due: the payment days, 60 or «30,60,90» or [30, 60, 90]",
					},
					end_of_month: { type: "boolean", description: "due: true for «fine mese» (f.m.), false or absent for «data fattura» (d.f.)" },
					fixed_day: { type: "integer", minimum: 1, maximum: 31, description: "due: the «giorno fisso» of the following month, e.g. 10 or 15" },
					month: { type: "string", minLength: 1, maxLength: 40, description: "working_days: the month, «novembre», «novembre 2026», 2026-11 or 11/2026" },
					year: { type: "integer", minimum: FIRST_YEAR, maximum: LAST_YEAR, description: "holidays: the year (this year if not given)" },
					inclusive: { type: "boolean", description: "between: count the starting day's working day too" },
					patrono: { type: "string", minLength: 1, maxLength: 30, description: "The local patron saint's day, 29/06 or «29 giugno», counted as a holiday" },
					saturday_working: { type: "boolean", description: "Saturdays are working days (a business open on Saturdays); not for due dates, which follow the banks" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args) {
				const problem = argsProblem(args);
				if (problem !== undefined) return `Errore: ${problem}.`;
				try {
					return answer(args, todayIn(options.timeZone, now()));
				} catch (error) {
					if (error instanceof DateError) return `Errore: ${error.message}.`;
					throw error;
				}
			},
		},
	];
}

/** Arguments of the wrong type, the way the other tools answer them. */
function argsProblem(args: Record<string, unknown>): string | undefined {
	if (!OPS.includes(args.op as Op)) return `op è una di queste: ${OPS.join(", ")}`;
	for (const name of ["date", "to", "month", "patrono"] as const) {
		if (args[name] !== undefined && typeof args[name] !== "string") return `${name} è un testo`;
		if (typeof args[name] === "string" && (args[name] as string).length > MAX_TEXT) return `${name} è troppo lungo`;
	}
	for (const name of ["inclusive", "end_of_month", "saturday_working"] as const) {
		if (args[name] !== undefined && typeof args[name] !== "boolean") return `${name} è true o false`;
	}
	if (args.amount !== undefined && !Number.isSafeInteger(args.amount)) return "amount è un numero intero";
	if (args.unit !== undefined && !UNITS.includes(args.unit as Unit)) return `unit è una di queste: ${UNITS.join(", ")}`;
	if (args.fixed_day !== undefined && !(Number.isInteger(args.fixed_day) && (args.fixed_day as number) >= 1 && (args.fixed_day as number) <= 31)) return "fixed_day è un giorno del mese, da 1 a 31";
	if (args.year !== undefined && !(Number.isInteger(args.year) && (args.year as number) >= FIRST_YEAR && (args.year as number) <= LAST_YEAR)) return `year è un anno dal ${FIRST_YEAR} al ${LAST_YEAR}`;
	return undefined;
}

function answer(args: Record<string, unknown>, today: string): string {
	const text = (name: string) => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? (args[name] as string) : undefined);
	const patrono = text("patrono") === undefined ? undefined : parseDayMonth(text("patrono") as string);
	const week: WorkingWeek = { ...(patrono === undefined ? {} : { patrono }), ...(args.saturday_working === true ? { saturdayWorking: true } : {}) };
	const date = text("date");
	const to = text("to");
	switch (args.op as Op) {
		case "info":
			if (date === undefined) return "Errore: manca date, la data da guardare.";
			return infoAnswer(parseDate(date, today), today, week);
		case "between": {
			if (to === undefined) return "Errore: manca to, la data di arrivo.";
			const from = parseDate(date ?? "oggi", today);
			return betweenAnswer(from, parseDate(to, today, { reference: from }), today, args.inclusive === true, week);
		}
		case "add": {
			if (args.amount === undefined) return "Errore: manca amount, quanto aggiungere (negativo per andare indietro).";
			const unit = (args.unit as Unit | undefined) ?? "days";
			return addAnswer(parseDate(date ?? "oggi", today), args.amount as number, unit, today, week);
		}
		case "due": {
			if (date === undefined) return "Errore: manca date, la data della fattura.";
			const days = daysOf(args.days);
			if (typeof days === "string") return `Errore: ${days}.`;
			// «30-60-90 f.m.» written in days says fine mese as clearly as end_of_month does.
			const saysEndOfMonth = typeof args.days === "string" && /(?<![a-z])(?:f\.?\s?m\.?|fine mese)(?![a-z])/i.test(args.days);
			if (saysEndOfMonth && args.end_of_month === false) return "Errore: days dice «fine mese» ma end_of_month è false.";
			const fixedDay = typeof args.fixed_day === "number" ? args.fixed_day : undefined;
			return dueAnswer(parseDate(date, today, { rule: "past" }), days, args.end_of_month === true || saysEndOfMonth, fixedDay, patrono);
		}
		case "working_days": {
			if (text("month") !== undefined) {
				const { year, month } = parseMonth(text("month") as string, today);
				const first = isoDate(year, month, 1);
				return workingAnswer(`${MONTH_NAMES[month - 1]} ${year}`, first, isoDate(year, month, daysInMonth(year, month)), week);
			}
			if (date === undefined || to === undefined) return "Errore: dammi month (un mese) oppure date e to (un intervallo).";
			const from = parseDate(date, today);
			const end = parseDate(to, today, { reference: from });
			if (end < from) return "Errore: to viene prima di date.";
			return workingAnswer(`da ${dayText(from)} a ${dayText(end)}, compresi`, from, end, week);
		}
		case "holidays":
			return holidaysAnswer(typeof args.year === "number" ? args.year : Number(today.slice(0, 4)), patrono);
		case "age": {
			if (date === undefined) return "Errore: manca date, la data di nascita.";
			const on = to === undefined ? today : parseDate(to, today);
			return ageAnswer(parseDate(date, today, { rule: "past", reference: on, yearNeeded: true }), on, today);
		}
	}
}

/** «30,60,90», «30/60/90», «30-60-90 gg», 60 or [30, 60, 90]: increasing whole days. */
function daysOf(value: unknown): number[] | string {
	const wrong = `days sono i giorni di pagamento, da 0 a ${MAX_DUE_DAYS}: 60, «30,60,90» o [30, 60, 90], al più ${MAX_INSTALMENTS}`;
	if (value === undefined) return "manca days, i giorni di pagamento (60, «30,60,90»…)";
	let list: unknown[];
	if (typeof value === "number") list = [value];
	else if (Array.isArray(value)) list = value;
	else if (typeof value === "string") {
		const cleaned = value.toLowerCase().replace(/\b[df]\.[fm]\./g, " ").replace(/(?<![a-z])(?:gg|giorni|days|df|fm|fine mese)(?![a-z])|\./g, " ").trim();
		if (!/^\d{1,3}(?:\s*[,;/\-+\s]\s*\d{1,3})*$/.test(cleaned)) return wrong;
		list = cleaned.split(/[\s,;/\-+]+/).map(Number);
	} else return wrong;
	if (list.length < 1 || list.length > MAX_INSTALMENTS || !list.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_DUE_DAYS)) return wrong;
	return [...new Set(list as number[])].sort((a, b) => a - b);
}

/** «lunedì 15/03/2027»: the weekday with every date. */
function dayText(date: string): string {
	return `${italianWeekday(date)} ${italianDate(date)}`;
}

function count(n: number, [one, many]: readonly [string, string]): string {
	return `${n.toLocaleString("it-IT")} ${n === 1 ? one : many}`;
}

const DAYS: readonly [string, string] = ["giorno", "giorni"];

/** «oggi», «domani», «ieri», «fra 5 giorni», «5 giorni fa». */
function fromToday(date: string, today: string): string {
	const n = daysBetween(today, date);
	if (n === 0) return "oggi";
	if (n === 1) return "domani";
	if (n === -1) return "ieri";
	return n > 0 ? `fra ${count(n, DAYS)}` : `${count(-n, DAYS)} fa`;
}

/** What the day is for work: a holiday (named), a weekend day, or a working day. */
function dayKind(date: string, week: WorkingWeek): string {
	const holiday = holidayOn(date, week.patrono);
	const weekday = weekdayOf(date);
	if (holiday !== undefined) return `festivo (${holiday})${weekday === 0 ? ", ed è domenica" : ""}`;
	if (weekday === 0) return "domenica, non lavorativo";
	if (weekday === 6) return week.saturdayWorking === true ? "giorno lavorativo (sabato lavorativo)" : "sabato, non lavorativo";
	return "giorno lavorativo";
}

/** «è festivo (Natale)» or «cade di domenica». */
function offWhy(date: string, holiday: string | undefined): string {
	return holiday === undefined ? `cade di ${italianWeekday(date)}` : `è festivo (${holiday})`;
}

function infoAnswer(date: string, today: string, week: WorkingWeek): string {
	const year = Number(date.slice(0, 4));
	const w = isoWeek(date);
	const isoYear = w.year === year ? "" : ` del ${w.year}`;
	return `${capitalized(dayText(date))} (${fromToday(date, today)}): ${dayKind(date, week)}. Settimana ISO ${w.week}${isoYear}, ${dayOfYear(date)}º giorno dell'anno su ${leapYear(year) ? 366 : 365}.`;
}

function betweenAnswer(from: string, to: string, today: string, inclusive: boolean, week: WorkingWeek): string {
	const reversed = to < from;
	const [start, end] = reversed ? [to, from] : [from, to];
	const s = span(start, end, inclusive, week);
	const n = count(s.days, DAYS);
	const parts = [...(s.weeks > 0 ? [`${count(s.weeks, ["settimana", "settimane"])}${s.weekDays > 0 ? ` e ${count(s.weekDays, DAYS)}` : ""}`] : []), ...(s.months > 0 ? [`${count(s.months, ["mese", "mesi"])}${s.monthDays > 0 ? ` e ${count(s.monthDays, DAYS)}` : ""}`] : [])];
	const split = `${parts.length > 0 ? ` (${parts.join("; ")})` : ""}${inclusive ? `; ${count(s.days + 1, DAYS)} contando sia il primo sia l'ultimo` : ""}`;
	let head: string;
	if (from === today && !reversed) head = `Da oggi, ${dayText(from)}, a ${dayText(to)}: ${s.days === 1 ? "manca" : "mancano"} ${n}${split}.`;
	else if ((from === today && reversed) || (to === today && !reversed)) head = `Da ${dayText(start)} a oggi, ${dayText(end)}: ${s.days === 1 ? "è passato" : "sono passati"} ${n}${split}.`;
	else if (reversed) head = `${capitalized(dayText(to))} viene ${n} prima di ${dayText(from)}${split}.`;
	else head = `Da ${dayText(from)} a ${dayText(to)}: ${n}${split}.`;
	const counted = inclusive ? "primo e ultimo giorno compresi" : "escluso il primo giorno, compreso l'ultimo";
	const lines = [head, `Giorni lavorativi: ${s.workingDays.toLocaleString("it-IT")} (${counted}; ${weekText(week)}${takenOff(s.holidays)}).`];
	if (from !== today && to !== today) lines.push(`Rispetto a oggi, ${italianDate(to)} è ${fromToday(to, today)}.`);
	return lines.join("\n");
}

/** «lunedì–venerdì meno i festivi», with Saturday and the patrono when they count. */
function weekText(week: WorkingWeek): string {
	return `${week.saturdayWorking === true ? "lunedì–sabato" : "lunedì–venerdì"} meno i festivi${week.patrono === undefined ? "" : " e il patrono"}`;
}

/** «: tolti 08/12 Immacolata Concezione e 25/12 Natale» for the holidays that fell on a working weekday. */
function takenOff(holidays: readonly (Holiday & { offWorkday: boolean })[]): string {
	const off = holidays.filter((h) => h.offWorkday);
	if (off.length === 0) return ", nessun festivo da togliere";
	if (off.length > MAX_LISTED) return `, tolti ${off.length} festivi`;
	return `: ${off.length === 1 ? "tolto" : "tolti"} ${joined(off.map((h) => `${italianDate(h.date)} ${h.name}`))}`;
}

function joined(items: readonly string[]): string {
	return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

function addAnswer(date: string, amount: number, unit: Unit, today: string, week: WorkingWeek): string {
	const added = addTo(date, amount, unit, week);
	const start = date === today ? `oggi, ${dayText(date)},` : dayText(date);
	const lines = [`${capitalized(start)} ${amount < 0 ? "−" : "+"} ${count(Math.abs(amount), UNIT_WORDS[unit])} = ${dayText(added.date)} (${fromToday(added.date, today)}).`];
	if (added.clamped) {
		const month = MONTH_NAMES[Number(added.date.slice(5, 7)) - 1];
		lines.push(`${capitalized(month as string)} ${added.date.slice(0, 4)} non ha il giorno ${Number(date.slice(8, 10))}: la data va all'ultimo giorno del mese.`);
	}
	if (unit === "working_days") {
		const skipped = added.skipped.length === 0 ? "" : ` e i festivi (${joined(added.skipped.map((h) => `${italianDate(h.date)} ${h.name}`))})`;
		lines.push(`Senza contare il giorno di partenza; saltati ${week.saturdayWorking === true ? "le domeniche" : "sabati e domeniche"}${week.patrono === undefined ? "" : ", il patrono"}${skipped}.`);
	} else if (!workingDay(added.date, week)) {
		lines.push(`Non è un giorno lavorativo: ${offWhy(added.date, holidayOn(added.date, week.patrono))}.`);
	}
	return lines.join("\n");
}

function dueAnswer(invoice: string, days: readonly number[], endOfMonth: boolean, fixedDay: number | undefined, patrono: string | undefined): string {
	const dues = dueDates(invoice, days, { endOfMonth, ...(fixedDay === undefined ? {} : { fixedDay }), ...(patrono === undefined ? {} : { patrono }) });
	const how = endOfMonth ? "f.m. (giorni dalla data fattura, poi fine mese" : "d.f. (giorni dalla data fattura";
	const fixed = fixedDay === undefined ? ")" : `; poi il giorno ${fixedDay} del mese dopo)`;
	const lines = dues.map((d) => {
		const slip = d.slip === undefined ? "" : ` — ${offWhy(d.date, d.slip.holiday)}: il pagamento slitta di solito al primo giorno lavorativo, ${dayText(d.slip.to)}`;
		const byMonths = d.byMonths === undefined ? "" : ` (contando 30 gg come un mese, come alcuni gestionali: ${dayText(d.byMonths)})`;
		return `${dayText(d.date)}${slip}${byMonths}`;
	});
	const head = `Fattura di ${dayText(invoice)}, ${days.join("-")} gg ${how}${fixed}`;
	return dues.length === 1 ? `${head}: scadenza ${lines[0]}.` : `${head}:\n${dues.map((d, i) => `• ${d.days} gg: ${lines[i]}`).join("\n")}`;
}

function workingAnswer(label: string, from: string, to: string, week: WorkingWeek): string {
	const c = workingDaysIn(from, to, week);
	const head = `${capitalized(label)}: ${count(c.working, ["giorno lavorativo", "giorni lavorativi"])} su ${c.total} (${weekText(week)}).`;
	if (c.holidays.length === 0) return `${head} Nessun festivo.`;
	const listed = c.holidays.slice(0, MAX_LISTED).map((h) => `${dayText(h.date)} ${h.name}${h.offWorkday ? "" : ` (già non lavorativo)`}`);
	const more = c.holidays.length > MAX_LISTED ? ` e altri ${c.holidays.length - MAX_LISTED}` : "";
	return `${head}\nFestivi: ${listed.join("; ")}${more}.`;
}

function holidaysAnswer(year: number, patrono: string | undefined): string {
	inRange(isoDate(year, 1, 1));
	const days = italianHolidays(year, patrono);
	const older = year < 2001 ? `\nÈ il calendario di oggi: prima del 2001 era diverso (dal 1977 al 2000 il 2 giugno si festeggiava di domenica, e fino al 1985 l'Epifania non era festiva).` : "";
	return `Festività nazionali del ${year}${patrono === undefined ? "" : " con il patrono"} (${days.length}):\n${days.map((h) => `• ${dayText(h.date)} ${h.name}`).join("\n")}${older}`;
}

function ageAnswer(birth: string, on: string, today: string): string {
	const age = ageOn(birth, on);
	const when = on === today ? "" : ` il ${italianDate(on)}`;
	const lines: string[] = [];
	if (age.daysToNext === 0) lines.push(`Chi è nato ${dayText(birth)} compie ${count(age.years, ["anno", "anni"])}${when === "" ? " oggi" : when}.`);
	else {
		const verb = on === today ? "ha" : on > today ? "avrà" : "aveva";
		lines.push(`Chi è nato ${dayText(birth)} ${verb} ${count(age.years, ["anno", "anni"])}${when}. Il prossimo compleanno (${age.years + 1}) è ${dayText(age.next)}, ${on === today ? fromToday(age.next, today) : `${count(age.daysToNext, DAYS)} dopo`}.`);
	}
	if (age.leapling) lines.push("Nato il 29 febbraio: negli anni non bisestili il compleanno si conta dal 1º marzo.");
	return lines.join(" ");
}
