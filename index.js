"use strict";

const rp = require('request-promise').defaults({jar:true});
const BP = require('bluebird');
const _ = require('lodash');
const path = BP.promisifyAll(require('path'));
const fs = BP.promisifyAll(require('fs'));
const readline = require('readline');
const moment = require('moment');
const argv = require('minimist')(process.argv.slice(2));

const cfgFileName = 'meazure.config.json';
const dateFmt = 'YYYY-MM-DD';

if (argv.help) {
  console.log(`Usage: node ${process.argv[0]} -f 2016-05-01 -t 2016-05-31`);
  console.log('\tLeaving off -f and -t will select the current full month');
  process.exit(0);
}

const utcOffset = moment().utcOffset();

if (!argv.f || !argv.t) {
  argv.f = moment().startOf('month').format(dateFmt);
  argv.t = moment().endOf('month').format(dateFmt);
}

fileExists(cfgFileName)
  .then(doesExist => {
    if (!doesExist) {
      return promptForCredentials()
        .then(writeConfigFile);
    } else {
      return readConfigFile();
    }
  })
  .then(cfg => {
    return login(cfg)
      .then(() => query({fromDate:argv.f, toDate:argv.t}))
      .then(entries => aggregateResults(entries, cfg))
      .then(addProjections)
      .then(r => console.log(`Results: ${argv.f} - ${argv.t}`, JSON.stringify(r, null, 2)));
  })
  .catch(e => {
    console.error('Error', e.message);
    if (e.stack) {
      console.error(e.stack);
    }
  });

function login(creds) {
  const url = "https://meazure.surgeforward.com/Auth/Login";
  return rp({
    method: 'POST',
    uri: url,
    body: {
      Email: creds.uname,
      Password: creds.pword
    },
    json: true,
    resolveWithFullResponse: true
  }).then(r => {
    if (r.body && r.body.Errors) {
      throw new Error('Invalid Credentials');
    }
    return true;
  });
}

function query(options) {
  const url = "https://meazure.surgeforward.com/Dashboard/RunQuery";
  const body = {
    "ContentType": 1,
    "ReturnFields": [
      "Date",
      "DurationSeconds",
      "ProjectName",
      "TaskName"
    ],
    "ReturnFieldWidths": null,
    "Criteria": [
      {
        "JoinOperator": "",
        "Field": "Date",
        "Operator": ">=",
        "Value": options.fromDate
      },
      {
        "JoinOperator": "and",
        "Field": "Date",
        "Operator": "<=",
        "Value": options.toDate
      }
    ],
    "Ordering": null
  };
  return rp({
    method: 'POST',
    uri: url,
    body: body,
    json: true
  });
}

function aggregateResults(entries, config) {
  const byProject = _.groupBy(entries, 'ProjectName');
  const aggregated = _.mapValues(byProject, (items, project) => {
    const summed = _.reduce(items, (memo, i) => {
        memo.DurationSeconds += i.DurationSeconds;
        return memo;
      }, {DurationSeconds: 0});
    const agg = {hours: summed.DurationSeconds / 60 / 60};
    let rate = 0;
    if (config.rates && config.rates[project]) {
      rate = config.rates[project];
    } else if (config.rates && config.rates._default) {
      rate = config.rates._default;
    }
    agg.earnings = rate * agg.hours;
    return agg;
  });
  aggregated.total = _.reduce(_.values(aggregated), (memo, entry) => {
      memo.hours += entry.hours;
      memo.earnings += entry.earnings;
      return memo;
    }, {hours: 0, earnings: 0});


  const now = moment().startOf('day');
  const tomorrow = moment().startOf('day').add(1, 'days');
  aggregated.haveEntryToday = false;
  if (_.find(entries, e => {

    // Meazure stores it's dates in an obsurd way. So e.Date is not the actual timestamp the entry was created
    // but the timestamp adjusted to the UTC offset of the local Meazure server (probably pacific)
    // This will work for timezones close to that of Meazure, otherwise, all bets are off.
    const m = moment(e.Date).add(-utcOffset, 'minutes');
    // console.log(e.Date, m.format(), now.format(), tomorrow.format(), e.Notes);
    return m.isSameOrAfter(now) && m.isSameOrBefore(tomorrow);
  })) {
    aggregated.haveEntryToday = true;
  }

  return aggregated;
}

function addProjections(entries) {
  const from = moment(argv.f, dateFmt);
  const to = moment(argv.t, dateFmt);
  if (from.isSameOrAfter(to)) {
    return entries;
  }
  let now = moment().startOf('day');
  let tomorrow = moment().startOf('day').add(1, 'days');
  if (entries.haveEntryToday) {
    now = tomorrow;
  }
  let c = from.clone();
  let weekDays = 0, weekDaysPast = 0;
  while(c.isSameOrBefore(to)) {
    if (c.weekday() < 6 && c.weekday() > 0) {
      weekDays += 1;
      if (c.isBefore(now)) {
        weekDaysPast += 1;
      }
    }
    c.add(1, 'days');
  }
  const ratioComplete = weekDaysPast/weekDays;
  const percentComplete = Math.floor(ratioComplete * 100);
  const earningsPerDay = Math.floor(entries.total.earnings / weekDaysPast);
  const estimatedEarnings = Math.floor(earningsPerDay * weekDays);
  const estimatedHours = weekDays * (entries.total.hours / weekDaysPast);
  entries.projections = {
    weekDays: weekDays,
    weekDaysPast: weekDaysPast,
    percentComplete: percentComplete,
    avgEarningsPerDay: earningsPerDay,
    avgHoursPerDay: entries.total.hours / weekDaysPast,
    estimatedEarnings: estimatedEarnings,
    estimatedHours: estimatedHours
  };
  return entries;
}

function readConfigFile() {
  return fs.readFileAsync(cfgFileName).then(JSON.parse);
}

function writeConfigFile(creds) {
  return fs.writeFileAsync(cfgFileName, JSON.stringify(creds, null, 2)).return(creds);
}

function promptForCredentials() {
  const rl = readline.createInterface({input:process.stdin, output: process.stdout});
  return new BP((resolve, reject) => {
    rl.question("Meazure username: ", uname => {
      rl.question("Meazure password: ", pword => {
        rl.close();
        resolve({uname: uname, pword: pword});
      });
    });
  });
}

function fileExists(f) {
  return fs.statAsync(f)
    .return(true)
    .catchReturn(false);
}
