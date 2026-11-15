// Parse OS / browser / device from a User-Agent string.
export function parseUA(ua = "") {
  let os = "Unknown", browser = "Unknown", model = "";
  let m;
  if ((m = ua.match(/Android\s([\d.]+)/))) {
    os = `Android ${m[1]}`;
    const mm = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild\/[^;)]*)?\)/);
    if (mm && mm[1] && mm[1].trim() !== "K") model = mm[1].trim();
  } else if ((m = ua.match(/(iPhone|iPad|iPod).*?OS\s([\d_]+)/))) {
    os = `iOS ${m[2].replace(/_/g, ".")}`; model = m[1];
  } else if ((m = ua.match(/Mac OS X\s([\d_.]+)/))) {
    os = `macOS ${m[1].replace(/_/g, ".")}`; model = "Mac";
  } else if ((m = ua.match(/Windows NT\s([\d.]+)/))) {
    os = `Windows ${{ "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" }[m[1]] || m[1]}`; model = "PC";
  } else if (/Linux/.test(ua)) { os = "Linux"; model = "PC"; }

  if ((m = ua.match(/EdgA?\/(\d+)/))) browser = `Edge ${m[1]}`;
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) browser = `Samsung Internet ${m[1]}`;
  else if ((m = ua.match(/OPR\/(\d+)/))) browser = `Opera ${m[1]}`;
  else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) browser = `Chrome ${m[1]}`;
  else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = `Safari ${m[1]}`;
  if (/FBAN|FBAV/.test(ua)) browser += " (Facebook app)";
  else if (/Instagram/.test(ua)) browser += " (Instagram app)";
  else if (/Viber/.test(ua)) browser += " (Viber)";
  return { os, browser, model };
}
