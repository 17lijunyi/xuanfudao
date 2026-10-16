'use strict';

const WEATHER_CODES = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪', 80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪', 95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
};

function createWeatherService({ fetchJson, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  const request = fetchJson || (async (url) => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(6500) });
    if (!response.ok) throw new Error('weather_unavailable');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error('weather_unavailable'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });

  async function getWeather(rawCity) {
    if (typeof rawCity !== 'string') return { ok: false, error: 'invalid_city' };
    const city = rawCity.trim();
    if (city.length < 2 || city.length > 80 || /[\u0000-\u001f]/.test(city)) return { ok: false, error: 'invalid_city' };
    const key = city.toLocaleLowerCase();
    const previous = cache.get(key);
    if (previous && now() - previous.updatedAt < 15 * 60_000) return { ...previous };
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 3) return { ok: false, error: 'weather_busy' };
    const work = (async () => {
      try {
        const search = new URL('https://geocoding-api.open-meteo.com/v1/search');
        search.search = new URLSearchParams({ name: city, count: '1', language: 'zh', format: 'json' }).toString();
        const found = (await request(search))?.results?.[0];
        if (!found) return { ok: false, error: 'city_not_found' };
        if (!Number.isFinite(found.latitude) || Math.abs(found.latitude) > 90 || !Number.isFinite(found.longitude) || Math.abs(found.longitude) > 180) throw new Error('invalid_location');
        const forecast = new URL('https://api.open-meteo.com/v1/forecast');
        forecast.search = new URLSearchParams({ latitude: String(found.latitude), longitude: String(found.longitude), current: 'temperature_2m,weather_code,is_day', timezone: 'auto', forecast_days: '1' }).toString();
        const current = (await request(forecast))?.current;
        if (typeof current?.temperature_2m !== 'number' || !Number.isFinite(current.temperature_2m) || Math.abs(current.temperature_2m) > 100) throw new Error('invalid_weather');
        const result = { ok: true, city: String(found.name || city).slice(0, 80), query: city, region: String(found.admin1 || found.country || '').slice(0, 80), temperature: current.temperature_2m, weatherCode: Number.isInteger(current.weather_code) ? current.weather_code : null, weatherText: WEATHER_CODES[current.weather_code] || '天气', isDay: current.is_day === 1, updatedAt: now(), attribution: 'Open-Meteo' };
        if (cache.size >= 20) cache.delete(cache.keys().next().value);
        cache.set(key, result);
        return { ...result };
      } catch (_) { return { ok: false, error: 'weather_unavailable' }; }
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  return { getWeather };
}
module.exports = { createWeatherService };
