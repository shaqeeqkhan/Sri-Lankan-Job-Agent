import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TITLE_GATE } from '../src/match/prefilter.ts';
import { parseTitle, personRange, rescuable, roleSimilarity, seniorityFit } from '../src/match/roles.ts';

/**
 * Real titles from Sri Lankan job boards (open jobs, 15 Nov 2026). PASS = eligible for the wanted title
 * (match ≥ TITLE_GATE); FAIL = not the same kind of role, even when a word is shared.
 */
const CASES: { wanted: string; pass: string[]; fail: string[] }[] = [
  {
    wanted: 'Software Engineer',
    pass: [
      'Software Engineer',
      'Senior Software Engineer – Fullstack (Java)',
      'Software Engineer (Full Stack)',
      'Backend Technical Lead (Node/TypeScript) - REF8600',
      'Senior Java Developer',
      '.NET Developer',
      'Web Developer',
      'Mobile Developers',
      'Full-Stack SaaS Developer',
      'Associate Tech Lead',
      'Software Architect | Colombo',
      'Intern - Software Engineering',
      'Software Engineering Intern',
      'Junior Software Engineer – C# / .NET',
      'Senior Lead / Principal Software Engineer (Agentic Engineering / Research) - IFS Labs',
    ],
    fail: [
      'Business Development Executive – ERP, EPOS & Software Solutions',
      'Software Implementation Officer – Intern',
      'Manager - Software Engineering',
      'QA Engineer Intern',
      'Civil Engineer',
      'Site Engineer | Rajagiriya',
      'Senior Lecturer | Lecturer - Civil Engineering',
      'Electrical Technical Officer | Senior Mechanical Engineer',
      'DevOps Engineer/Senior DevOps Engineer - Platform',
      'Network Engineer',
      'Data Entry Operator',
    ],
  },
  {
    wanted: 'Backend Engineer',
    pass: ['Backend Technical Lead (Node/TypeScript) - REF8600', 'Senior Software Engineer - Full Stack', 'Backend Developer', 'Back-end Developer (Node.js)'],
    fail: ['Frontend Developer Intern', 'Business Development Executive'],
  },
  {
    wanted: 'Accounts Executive',
    pass: [
      'Accounts Executive',
      'Accountant',
      'Junior Accountant',
      'Accounts Assistant - Wattala',
      'Junior Executive Admin and Accounts',
      'Accountant Cum Administrative Officer | Colombo 03',
      'Accountant | Assistant Accountant | Senior Accounts Executive',
      'Senior Associate - Accounts Receivable',
      'Account Assistant',
      'Finance Executive',
    ],
    fail: ['Key Account Executive', 'Account Manager', 'Sales Executive', 'Data Entry Operator', 'Executive - Human Resources'],
  },
  {
    wanted: 'Marketing Executive',
    pass: [
      'Marketing Executive',
      'Executive - Digital Marketing',
      'Sales and Marketing Executive',
      'Brand Executive',
      'Social Media Executive',
      'Student Counselor | Marketing Executive | Enrollment Manager',
      'Junior Executive Marketing -Colombo 10 (MALE) (1)',
      // Same function, a manager's head noun: passes on title, and seniority ranks it down for an executive.
      'Marketing Manager',
    ],
    fail: [
      'Tour Executive - Indian Market | Trainee Tour Executive (Graduates | School Leavers)',
      'Business Development Executive',
      'Sales Executive',
      'Accounts Executive',
    ],
  },
  {
    wanted: 'QA Engineer',
    pass: ['Senior QA Engineer (Manual & Automation)', 'Software Quality Assurance - Intern', 'Intern - Quality Assurance Engineer', 'Software Tester'],
    fail: ['Software Engineer', 'Production Engineer', 'Senior DevOps Engineer'],
  },
];

for (const c of CASES) {
  test(`title match for "${c.wanted}": head noun and function decide, not a shared word`, () => {
    for (const t of c.pass) assert.ok(roleSimilarity(t, c.wanted) >= TITLE_GATE, `should pass: "${t}" (${roleSimilarity(t, c.wanted)})`);
    for (const t of c.fail) assert.ok(roleSimilarity(t, c.wanted) < TITLE_GATE, `should fail: "${t}" (${roleSimilarity(t, c.wanted)})`);
  });
}

test('equivalents: engineer = developer = programmer; QA = test; accounts = accounting = accountant', () => {
  assert.equal(roleSimilarity('Java Programmer', 'Java Developer'), 1);
  assert.equal(roleSimilarity('Software Developer', 'Software Engineer'), 1);
  assert.equal(roleSimilarity('Test Engineer', 'QA Engineer'), 1);
  assert.ok(roleSimilarity('Accounting Executive', 'Accounts Executive') === 1);
  assert.ok(roleSimilarity('Full Stack Developer', 'Backend Developer') >= 0.8);
  // A shared word in a qualifier is not enough.
  assert.ok(roleSimilarity('Business Development Executive – Software Solutions', 'Software Developer') < 0.5);
});

test('parseTitle: roles, heads, functions, qualifiers and levels', () => {
  const p = parseTitle('Senior Software Engineer – Fullstack (Java)');
  assert.deepEqual(p.roles, [{ head: 'engineer', funcs: ['software'], qual: ['java', 'fullstack'], levels: [3] }]);
  assert.deepEqual(p.levels, [3]);
  assert.deepEqual(parseTitle('Executive - Digital Marketing').roles[0].funcs, ['digital', 'marketing']);
  assert.deepEqual(parseTitle('Intern - Software Engineering').levels, [0]);
  assert.equal(parseTitle('Accountant | Assistant Accountant | Senior Accounts Executive').roles.length, 3);
  assert.equal(parseTitle('Head of Accounting').roles[0].head, 'headof');
  assert.deepEqual(parseTitle('Head of Accounting').levels, [5]);
});

test('seniority: a mid-level person is not shown interns first; a junior is not shown "Head of"', () => {
  const mid = personRange('mid', 4, [parseTitle('Software Engineer')]);
  assert.deepEqual(mid, [2, 2]);
  const fit = (t: string, p: [number, number]) => seniorityFit(parseTitle(t), p).fit;
  assert.equal(fit('Software Engineer', mid), 1);
  assert.ok(fit('Senior Software Engineer', mid) >= 0.7);
  assert.ok(fit('Software Engineer Intern', mid) <= 0.3);
  assert.ok(fit('Software Engineer Intern', mid) < fit('Associate Software Engineer', mid));
  // Target titles that name a level open it: "Senior Software Engineer" as a target.
  assert.deepEqual(personRange('mid', 4, [parseTitle('Software Engineer'), parseTitle('Senior Software Engineer')]), [2, 3]);
  const junior = personRange('junior', 2, [parseTitle('Accounts Executive')]);
  assert.ok(fit('Head of Accounting', junior) <= 0.1);
  assert.equal(fit('Junior Accountant', junior), 1);
  // In a multi-role title, the level is the matched role's.
  const t = parseTitle('Student Counselor | Marketing Executive | Enrollment Manager');
  assert.equal(seniorityFit(t, [2, 2], 1).fit, 1);
  assert.ok(seniorityFit(t, [2, 2]).fit < 1);
});

test('skills rescue applies only to unusual titles with a compatible head noun', () => {
  const se = [parseTitle('Software Engineer')];
  assert.equal(rescuable(parseTitle('Technical Onboarding Engineer - IFS Logistics'), se), true);
  assert.equal(rescuable(parseTitle('Forward Deployed Engineer'), se), true);
  assert.equal(rescuable(parseTitle('Senior QA Engineer (Manual & Automation)'), se), false, 'QA is another job, not an unusual title');
  assert.equal(rescuable(parseTitle('Business Development Executive'), se), false, 'a sales executive is not an engineer');
});
