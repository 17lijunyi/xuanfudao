const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherService } = require('../weather-service');

test('weather only requests fixed public hosts, validates data and shares cached reads', async () => {
  const urls = []; let time = 1000;
  const service = createWeatherService({ now: () => time, fetchJson: async (url) => {
    urls.push(url.href);
    return url.hostname.startsWith('geocoding') ? {results: [{name: '上海',latitude: 31.2,longitude: 121.5}]} : {current: {temperature_2m: 25.4, weather_code: 0, is_day: 1}};
  } });
  const first = await service.getWeather('上海');
  assert.equal(first.temperature, 25.4); assert.equal(first.weatherText, '晴');
  await service.getWeather('上海'); assert.equal(urls.length, 2);
  assert.deepEqual(urls.map(url => new URL(url).hostname), ['geocoding-api.open-meteo.com', 'api.open-meteo.com']);
  assert.equal((await service.getWeather('')).ok, false);
  time += 16 * 60_000; await service.getWeather('上海'); assert.equal(urls.length, 4);
});

test('weather missing location, null temperature or network failure never become zero readings', async () => {
  const missing = createWeatherService({fetchJson: async () => ({})});
  assert.equal((await missing.getWeather('未知城市')).error, 'city_not_found');
  const empty = createWeatherService({fetchJson: async url => url.hostname.startsWith('geocoding') ? {results: [{latitude: 0,longitude: 0}]} : {current: {temperature_2m: null}}});
  assert.equal((await empty.getWeather('测试城市')).ok, false);
});
