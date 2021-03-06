#!/usr/bin/env node

'use strict';

const BufferReader = require('./libs/buffer'),
      chalk        = require('chalk'),
      crypto       = require('crypto'),
      fs           = require('fs'),
      hummus       = require('hummus'),
      os           = require('os'),
      parser       = require('./libs/nomnom'),
      path         = require('path'),
      puppeteer    = require('puppeteer');

const { delay, pause } = require('./libs/util');

const plugins = loadAvailablePlugins(path.join(path.dirname(__filename), 'plugins'));

parser.script('decktape').options({
  url : {
    position : 1,
    required : true,
    help     : 'URL of the slides deck',
  },
  filename : {
    position : 2,
    required : true,
    help     : 'Filename of the output PDF file',
  },
  size : {
    abbr      : 's',
    metavar   : '<size>',
    type      : 'string',
    callback  : parseSize,
    transform : parseSize,
    help      : 'Size of the slides deck viewport: <width>x<height>  (ex. 1280x720)',
  },
  pause : {
    abbr    : 'p',
    metavar : '<ms>',
    default : 1000,
    help    : 'Duration in milliseconds before each slide is exported',
  },
  loadPause : {
    full    : 'load-pause',
    metavar : '<ms>',
    default : 0,
    help    : 'Duration in milliseconds between the page has loaded and starting to export slides',
  },
  screenshots : {
    default : false,
    flag    : true,
    help    : 'Capture each slide as an image',
  },
  screenshotDirectory : {
    full    : 'screenshots-directory',
    metavar : '<dir>',
    default : 'screenshots',
    help    : 'Screenshots output directory',
  },
  screenshotSize : {
    full      : 'screenshots-size',
    metavar   : '<size>',
    type      : 'string',
    list      : true,
    callback  : parseSize,
    transform : parseSize,
    help      : 'Screenshots resolution, can be repeated',
  },
  screenshotFormat : {
    full    : 'screenshots-format',
    metavar : '<format>',
    default : 'png',
    choices : ['jpg', 'png'],
    help    : 'Screenshots image format, one of [jpg, png]',
  },
  slides : {
    metavar   : '<range>',
    type      : 'string',
    callback  : parseRange,
    transform : parseRange,
    help      : 'Range of slides to be exported, a combination of slide indexes and ranges (e.g. \'1-3,5,8\')',
  },
  // Chrome options
  executablePath : {
    full    : '--executablePath',
    metavar : '<path>',
    hidden  : true,
    type    : 'string',
  },
  noSandbox : {
    full   : '--no-sandbox',
    hidden : true,
    flag   : true,
  },
});

function parseSize(size) {
  // TODO: support device viewport sizes and graphics display standard resolutions
  // see http://viewportsizes.com/ and https://en.wikipedia.org/wiki/Graphics_display_resolution
  const [, width, height] = size.match(/^(\d+)x(\d+)$/);
  if (!width || !height)
    return '<size> must follow the <width>x<height> notation, e.g., 1280x720';
  else
    return { width: parseInt(width), height: parseInt(height) };
}

function parseRange(range) {
  const regex = /(\d+)(?:-(\d+))?/g;
  if (!range.match(regex))
    return '<range> must be a combination of slide indexes and ranges, e.g., \'1-3,5,8\'';
  let slide, slides = {};
  while ((slide = regex.exec(range)) !== null) {
    const [, m, n] = slide.map(i => parseInt(i));
    if (isNaN(n)) {
      slides[m] = true;
    } else {
      for (let i = m; i <= n; i++) {
        slides[i] = true;
      }
    }
  }
  return slides;
}

parser.command('version')
  .root(true)
  .help('Display decktape package version')
  .callback(_ => {
    console.log(require('./package.json').version);
    process.exit();
  });
parser.nocommand()
.help(
`Defaults to the automatic command.
Iterates over the available plugins, picks the compatible one for presentation at the
specified <url> and uses it to export and write the PDF into the specified <filename>.`
);
parser.command('automatic')
.help(
`Iterates over the available plugins, picks the compatible one for presentation at the
specified <url> and uses it to export and write the PDF into the specified <filename>.`
);
Object.entries(plugins).forEach(([id, plugin]) => {
  const command = parser.command(id);
  if (typeof plugin.options === 'object')
    command.options(plugin.options);
  if (typeof plugin.help === 'string')
    command.help(plugin.help);
});
// TODO: should be deactivated as well when it does not execute in a TTY context
if (os.name === 'windows') parser.nocolors();

const options = parser.parse(process.argv.slice(2));

process.on('unhandledRejection', error => {
  console.log(error.stack);
  process.exit(1);
});

(async () => {

  const browser = await puppeteer.launch({
    headless : true,
    executablePath: options.executablePath,
    args     : Object.keys(options).reduce((args, option) => {
      switch (option) {
        case 'sandbox':
          if (options.sandbox === false) args.push('--no-sandbox');
          break;
      }
      return args;
    }, [])
  });
  const page = await browser.newPage();
  await page.emulateMedia('screen');
  const printer = hummus.createWriter(options.filename);
  const metadata = printer.getDocumentContext().getInfoDictionary();
  metadata.creator = 'Decktape';

  page
    .on('console', (...args) => console.log(chalk`{gray ${args}}`))
    .on('pageerror', error => console.log(chalk`\n{red Page error: ${error.message}}`))
    .on('requestfailed', request => console.log(chalk`\n{keyword('orange') Unable to load resource from URL: ${request.url}}`));

  console.log('Loading page', options.url, '...');
  page.goto(options.url, { waitUntil: 'load', timeout: 60000 })
    .then(response => console.log('Loading page finished with status:', response.status))
    .then(delay(options.loadPause))
    .then(_ => createPlugin(page))
    .then(plugin => configurePlugin(plugin)
      .then(_ => configurePage(plugin, page))
      .then(_ => exportSlides(plugin, page, printer))
      .then(context => {
        printer.end();
        console.log(chalk`{green \nPrinted {bold ${context.exportedSlides}} slides}`);
        browser.close();
        process.exit();
      }))
    .catch(error => {
      console.log(chalk`{red \n${error}}`);
      browser.close();
      process.exit(1);
    });

})();

function loadAvailablePlugins(pluginsPath) {
  return fs.readdirSync(pluginsPath).reduce((plugins, pluginPath) => {
    const [, plugin] = pluginPath.match(/^(.*)\.js$/);
    if (plugin && fs.statSync(path.join(pluginsPath, pluginPath)).isFile())
      plugins[plugin] = require('./plugins/' + plugin);
    return plugins;
  }, {});
}

async function createPlugin(page) {
  let plugin;
  if (!options.command || options.command === 'automatic') {
    plugin = await createActivePlugin(page);
    if (!plugin) {
      console.log('No supported DeckTape plugin detected, falling back to generic plugin');
      plugin = plugins['generic'].create(page, options);
    }
  } else {
    plugin = plugins[options.command].create(page, options);
    if (!await plugin.isActive()) {
      throw Error(`Unable to activate the ${plugin.getName()} DeckTape plugin for the address: ${options.url}`);
    }
  }
  console.log(chalk`{cyan {bold ${plugin.getName()}} plugin activated}`);
  return plugin;
}

async function createActivePlugin(page) {
  for (let id in plugins) {
    if (id === 'generic') continue;
    const plugin = plugins[id].create(page, options);
    if (await plugin.isActive()) return plugin;
  }
}

async function configurePage(plugin, page) {
  if (!options.size) {
    options.size = typeof plugin.size === 'function'
      ? await plugin.size()
      // TODO: per-plugin default size
      : { width: 1280, height: 720 };
  }
  await page.setViewport(options.size);
}

async function configurePlugin(plugin) {
  if (typeof plugin.configure === 'function')
    await plugin.configure();
}

async function exportSlides(plugin, page, printer) {
  const context = {
    progressBarOverflow : 0,
    currentSlide        : 1,
    exportedSlides      : 0,
    pdfXObjects         : {},
    totalSlides         : await plugin.slideCount(),
  };
  // TODO: support a more advanced "fragment to pause" mapping
  // for special use cases like GIF animations
  // TODO: support plugin optional promise to wait until a particular mutation
  // instead of a pause
  if (options.slides && !options.slides[context.currentSlide]) {
    process.stdout.write('\r' + await progressBar(plugin, context, { skip: true }));
  } else {
    await pause(options.pause);
    await exportSlide(plugin, page, printer, context);
  }
  const maxSlide = options.slides ? Math.max(...Object.keys(options.slides)) : Infinity;
  let hasNext = await hasNextSlide(plugin, context);
  while (hasNext && context.currentSlide < maxSlide) {
    await nextSlide(plugin, context);
    await pause(options.pause);
    if (options.slides && !options.slides[context.currentSlide]) {
      process.stdout.write('\r' + await progressBar(plugin, context, { skip: true }));
    } else {
      await exportSlide(plugin, page, printer, context);
    }
    hasNext = await hasNextSlide(plugin, context);
  }
  return context;
}

async function exportSlide(plugin, page, printer, context) {
  process.stdout.write('\r' + await progressBar(plugin, context));

  const buffer = await page.pdf({
    width               : options.size.width + 'px',
    height              : options.size.height + 'px',
    printBackground     : true,
    pageRanges          : '1',
    displayHeaderFooter : false,
  });
  printSlide(printer, new BufferReader(buffer), context);
  context.exportedSlides++;

  if (options.screenshots) {
    for (let resolution of options.screenshotSize || [options.size]) {
      await page.setViewport(resolution);
      // Delay page rendering to wait for the resize event to complete,
      // e.g. for impress.js (may be needed to be configurable)
      await pause(1000);
      await page.screenshot({
        path           : path.join(options.screenshotDirectory, options.filename.replace('.pdf',
                         `_${context.currentSlide}_${resolution.width}x${resolution.height}.${options.screenshotFormat}`)),
        fullPage       : false,
        omitBackground : true,
      });
      await page.setViewport(options.size);
      await pause(1000);
    }
  }
}

// https://github.com/galkahana/HummusJS/wiki/Embedding-pdf#low-levels
function printSlide(printer, buffer, context) {
  const objCxt = printer.getObjectsContext();
  const cpyCxt = printer.createPDFCopyingContext(buffer);
  const cpyCxtParser = cpyCxt.getSourceDocumentParser();
  const pageDictionary = cpyCxtParser.parsePageDictionary(0).toJSObject();
  const xObjects = {};

  function parseXObject(xObject) {
    const pdfStreamInput = cpyCxtParser.parseNewObject(xObject.getObjectID());
    const xObjectDictionary = pdfStreamInput.getDictionary().toJSObject();
    if (xObjectDictionary.Subtype.value === 'Image') {
      // Create a hash of the compressed stream instead of using
      // startReadingFromStream(pdfStreamInput) to skip uneeded decoding
      const stream = cpyCxtParser.getParserStream();
      stream.setPosition(pdfStreamInput.getStreamContentStart());
      const digest = crypto.createHash('SHA1')
        .update(Buffer.from(stream.read(pdfStreamInput.getDictionary().toJSObject().Length.value)))
        .digest('hex');
      if (!context.pdfXObjects[digest]) {
        xObjects[digest] = xObject.getObjectID();
      } else {
        const replacement = {};
        replacement[xObject.getObjectID()] = context.pdfXObjects[digest];
        cpyCxt.replaceSourceObjects(replacement);
      }
    } else {
      parseResources(xObjectDictionary);
    }
  }

  function parseResources(dictionary) {
    const resources = dictionary.Resources.toJSObject();
    if (resources.XObject) {
      Object.values(resources.XObject.toJSObject()).forEach(parseXObject);
    }
  }
  // Collect xObjects and eventually replace with shared references
  parseResources(pageDictionary);
  // Copy the links on page write
  if (pageDictionary.Annots) {
    const annotations = pageDictionary.Annots.toJSArray()
      .filter(annotation => annotation.toJSObject().Subtype.value === 'Link');
    printer.getEvents().once('OnPageWrite', event => {
      event.pageDictionaryContext.writeKey('Annots');
      objCxt.startArray();
      annotations.forEach(annotation => cpyCxt.copyDirectObjectAsIs(annotation));
      objCxt.endArray(hummus.eTokenSeparatorEndLine);
    });
  }
  // Copy the page
  cpyCxt.appendPDFPageFromPDF(0);
  // And finally update the context XObject ids mapping with the copy ids
  const copiedObjects = cpyCxt.getCopiedObjects();
  Object.entries(xObjects)
    .forEach(([digest, id]) => context.pdfXObjects[digest] = copiedObjects[id]);
}

async function hasNextSlide(plugin, context) {
  if (typeof plugin.hasNextSlide === 'function')
    return await plugin.hasNextSlide();
  else
    return context.currentSlide < context.totalSlides;
}

async function nextSlide(plugin, context) {
  context.currentSlide++;
  return plugin.nextSlide();
}

// TODO: add progress bar, duration, ETA and file size
async function progressBar(plugin, context, { skip } = { skip : false }) {
  const cols = [];
  const index = await plugin.currentSlideIndex();
  cols.push(`${skip ? 'Skipping' : 'Printing'} slide `);
  cols.push(`#${index}`.padEnd(8));
  cols.push(' (');
  cols.push(`${context.currentSlide}`.padStart(context.totalSlides ? context.totalSlides.toString().length : 3));
  cols.push('/');
  cols.push(context.totalSlides || ' ?');
  cols.push(') ...');
  // erase overflowing slide fragments
  cols.push(' '.repeat(Math.max(context.progressBarOverflow - Math.max(index.length + 1 - 8, 0), 0)));
  context.progressBarOverflow = Math.max(index.length + 1 - 8, 0);
  return cols.join('');
}
