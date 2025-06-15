interface UnrefableTimer {
	unref(): void;
}

export const unref = (timer: number | object): void => {
	(timer as UnrefableTimer).unref();
};
