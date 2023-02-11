export const unref = (interval: ReturnType<typeof setInterval>) => {
  interval.unref();
};
