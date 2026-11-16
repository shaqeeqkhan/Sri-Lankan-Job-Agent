import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISTRICTS, findDistrict, nearbyDistricts, parsePlace } from '../src/jobs/places.ts';

test('all 25 districts parse to themselves', () => {
  assert.equal(DISTRICTS.length, 25);
  for (const d of DISTRICTS) {
    const p = parsePlace(d);
    assert.equal(p.district, d, d);
    assert.equal(p.slug, d.toLowerCase().replace(/ /g, '-'), d);
  }
});

test('cities, suburbs and Colombo postal zones map to their district', () => {
  const cases: [string, string, string][] = [
    ['Colombo 03', 'Colombo', 'colombo'],
    ['Colombo-07', 'Colombo', 'colombo'],
    ['Col 3', 'Colombo', 'colombo'],
    ['Colombo 15, Sri Lanka', 'Colombo', 'colombo'],
    ['Dehiwala', 'Colombo', 'colombo'],
    ['Mount Lavinia', 'Colombo', 'colombo'],
    ['Nugegoda', 'Colombo', 'colombo'],
    ['Maharagama', 'Colombo', 'colombo'],
    ['Sri Jayawardenepura Kotte', 'Colombo', 'colombo'],
    ['Battaramulla', 'Colombo', 'colombo'],
    ['Moratuwa', 'Colombo', 'colombo'],
    ['Negombo', 'Gampaha', 'gampaha'],
    ['Katunayake EPZ', 'Gampaha', 'gampaha'],
    ['Biyagama', 'Gampaha', 'gampaha'],
    ['Ja-Ela', 'Gampaha', 'gampaha'],
    ['Kandy', 'Kandy', 'kandy'],
    ['Peradeniya', 'Kandy', 'kandy'],
    ['Galle', 'Galle', 'galle'],
    ['Jaffna', 'Jaffna', 'jaffna'],
    ['Nuwara Eliya', 'Nuwara Eliya', 'nuwara-eliya'],
    ['Hatton', 'Nuwara Eliya', 'nuwara-eliya'],
    ['Kurunegala', 'Kurunegala', 'kurunegala'],
    ['Bandarawela', 'Badulla', 'badulla'],
  ];
  for (const [loc, district, slug] of cases) {
    const p = parsePlace(loc);
    assert.equal(p.district, district, loc);
    assert.equal(p.slug, slug, loc);
  }
});

test('a street named after a town is not that town', () => {
  assert.equal(parsePlace('No. 45, Galle Road, Colombo 03').slug, 'colombo');
  assert.equal(parsePlace('Kandy Road, Kadawatha').slug, 'gampaha');
});

test('several districts: sorted slug, first named is the district', () => {
  const p = parsePlace('Kandy / Colombo');
  assert.equal(p.district, 'Kandy');
  assert.equal(p.slug, 'colombo,kandy');
});

test('remote, placeholders, country only and foreign places', () => {
  assert.deepEqual(parsePlace('Remote'), { district: null, slug: null, remote: true });
  assert.deepEqual(parsePlace('Work from home'), { district: null, slug: null, remote: true });
  assert.deepEqual(parsePlace('Colombo (Hybrid)'), { district: 'Colombo', slug: 'colombo', remote: false });
  assert.deepEqual(parsePlace('Remote - Colombo'), { district: 'Colombo', slug: 'colombo', remote: true });
  assert.deepEqual(parsePlace('Island wide'), { district: null, slug: null, remote: false });
  assert.deepEqual(parsePlace('Sri Lanka'), { district: null, slug: 'lk', remote: false });
  assert.deepEqual(parsePlace(''), { district: null, slug: null, remote: false });
  assert.deepEqual(parsePlace(null), { district: null, slug: null, remote: false });
  assert.equal(parsePlace('Dubai, UAE').slug, 't:dubai,uae');
  assert.notEqual(parsePlace('Doha, Qatar').slug, parsePlace('Dubai, UAE').slug);
});

test('nearbyDistricts is symmetric and accepts names or slugs', () => {
  assert.deepEqual(nearbyDistricts('Colombo'), ['Gampaha', 'Kalutara', 'Kegalle', 'Ratnapura']);
  assert.ok(nearbyDistricts('nuwara-eliya').includes('Kandy'));
  for (const d of DISTRICTS) {
    assert.ok(nearbyDistricts(d).length > 0, d);
    for (const n of nearbyDistricts(d)) assert.ok(nearbyDistricts(n).includes(d), `${d} <-> ${n}`);
  }
  assert.deepEqual(nearbyDistricts('Atlantis'), []);
  assert.equal(findDistrict('NUWARA ELIYA'), 'Nuwara Eliya');
});

test('towns found unknown in the first live scan (I1) map to their districts', () => {
  assert.equal(parsePlace('Angulana').district, 'Colombo');
  assert.equal(parsePlace('Mulleriyawa').district, 'Colombo');
  assert.equal(parsePlace('Rathmalana').district, 'Colombo');
  assert.equal(parsePlace('Kotikawatta').district, 'Colombo');
  assert.equal(parsePlace('Hanthana').district, 'Kandy');
});
