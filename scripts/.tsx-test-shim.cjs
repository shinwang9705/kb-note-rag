// Windows CI fallback: tsx calls os.userInfo() only when geteuid is absent.
// Some restricted Windows runners reject that syscall; a stable numeric id is sufficient for its temp directory.
if (process.platform === 'win32' && typeof process.geteuid !== 'function') process.geteuid = () => 0;
