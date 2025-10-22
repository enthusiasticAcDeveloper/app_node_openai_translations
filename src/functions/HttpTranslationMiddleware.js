const { app } = require('@azure/functions');

const FTPClient = require('ssh2-sftp-client'); 
const OpenAI = require("openai").default;
const OpenAIApi = require("openai").default;
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const fs = require('fs');
const nodemailer = require("nodemailer");
const csv = require('csv-parser');
const xlsx = require('xlsx');
const path2 = require('path');
const prompt = require( __dirname + '/res/configuration_prompt');
const env = require( __dirname + '/res/.env-local');
const directoryPath = path2.join( __dirname, 'tmp' );
if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync( directoryPath, { recursive: true });
}
const tmpPath = path2.join(__dirname, 'tmp');

let _nameFileLog = '';
let _nameFileLogNotificationDev = '';

function tt() {
    const options = { timeZone: 'Europe/Rome' };
    const _dataCorrente = new Date().toLocaleString('it-IT', options);
    const [datePart, timePart] = _dataCorrente.split(', ');
    const formattedDate = datePart.split('/').map(part => part.padStart(2, '0')).reverse().join('');
    const formattedTime = timePart.slice(0, 8);
    return [formattedDate, formattedTime];
}
let branch = process.env["_BRANCH"] ? process.env["_BRANCH"] : env["_BRANCH"];

let ENVIRONMENT = 'bata';

const numberItemBlock = process.env["NUMBER_ITEM_BLOCK_"+branch] ? process.env["NUMBER_ITEM_BLOCK_"+branch] : env["NUMBER_ITEM_BLOCK_"+branch];
const MODELNAME = process.env["MODEL_"+branch] ? process.env["MODEL_"+branch] : env["MODEL_"+branch];

const dictionaryLanguages = [
    { it: 'italiano' },
    { fr: 'francese' },
    { en: 'inglese' },
    { ce: 'ceco' },
    { cz: 'cecoslovacco' },
    { cs: 'ceco' },
    { sk: 'cecoslovacco' },
    { pl: 'polacco' },
    { es: 'spagnolo' },
    { de: 'tedesco' },
    { pt: 'portoghese' },
];

let success = {
    downloadFile: false,
    createBlock: false,
    openaiTranslations: false,
    parsingFile: false,
    uploadFile: false,
    removeLocalFile: false,
    renameRemoteFile: false,
};

const _SFTPConfig = {
    host: process.env[ "AWS_SFTP_HOST_"+branch ] ? process.env[ "AWS_SFTP_HOST_"+branch] : env[ "AWS_SFTP_HOST_"+branch],
    port: process.env[ "AWS_SFTP_PORT_"+branch ] ? process.env[ "AWS_SFTP_PORT_"+branch ]  : env[ "AWS_SFTP_PORT_"+branch ],
    username: process.env[ "AWS_SFTP_USER_"+branch ] ? process.env[ "AWS_SFTP_USER_"+branch ] : env[ "AWS_SFTP_USER_"+branch ],
    password: process.env[ "AWS_SFTP_PASSWORD_"+branch ] ? process.env[ "AWS_SFTP_PASSWORD_"+branch ]  : env[ "AWS_SFTP_PASSWORD_"+branch ],
    readyTimeout: 30000,
};

async function readDictionary( _linguaDestinazione ) {
    const _percorsoFile = path2.join( __dirname, 'res/dizionari', `dizionario_${ENVIRONMENT}_${_linguaDestinazione}.json` );
    try {
        const _data = fs.readFileSync(_percorsoFile, 'utf8');
        return JSON.parse( _data);
    } catch (error) {
        // console.error(`Errore durante il caricamento del dizionario per la lingua '${linguaDestinazione}':`, error);
        return null;
    }
}

async function readConfiguration( context ) {
    const _percorsoFile = path2.join( __dirname, 'res', `configuration_${ENVIRONMENT}_${branch}.json` );
    try {
        const _configurazioneRaw = await fs.readFileSync( _percorsoFile );
        const _configurazione = JSON.parse( _configurazioneRaw );
        return _configurazione;
    } catch ( errore ) {
        context.log( errore );
        throw errore;
    }
}

async function sftpInteract( context ){
    const _sftp = new FTPClient();
    const _configurationJson = await readConfiguration(context);
    const _remoteFolderPath = _configurationJson.FUN_REMOTE_FOLDER;
    const _partialFiles = [];
    const _fullFiles = [];
    const _remainingFiles = [];
    try {
        await _sftp.connect( _SFTPConfig );
        const _files = await _sftp.list( _remoteFolderPath );
        const _filesWithExtensions = _files.map( file => {
            const fileName = file.name;
            const fileExtension = fileName.split('.').pop();
            const parsedPath = path2.parse( fileName );
            return { name: fileName, type: fileExtension, nameWithoutExtension: parsedPath.name };
        });
        _filesWithExtensions.forEach( _file => {
            const _fileNameWithoutExtension = _file.name.split( '.' )[ 0 ];
            if ( _fileNameWithoutExtension.endsWith( '_parsed' ) ) {
                _fullFiles.push(_file);
            } else if ( _fileNameWithoutExtension.endsWith( '_partial' ) ) {
                _partialFiles.push( _file );
            } else {
                _remainingFiles.push( _file );
            }
        });
        const _localFolderPath = tmpPath;
        for ( const key in _remainingFiles ) {
            const _file = _remainingFiles[key];
            const _remoteFilePath = `${_remoteFolderPath}/${_file.name}`;
            const _localFilePath = `${_localFolderPath}/${_file.name}`;
            try {
                context.log( `${tt()[0]} ${tt()[1]} --- start download ${_remoteFilePath}` );
                await _sftp.get( _remoteFilePath, _localFilePath );
                context.log(`File scaricato con successo: ${_file.name}`);
            } catch (downloadError) {
                context.log(`Errore durante il download del file ${_file.name}:`, downloadError.message);
            }
        }
        await _sftp.end();
        context.log( `${tt()[0]} ${tt()[1]} --- end download` );
    } catch (err) {
        context.log('Errore durante l\'operazione di SFTP:', err);
    }

    return { remainingFiles: _remainingFiles, partialFiles: _partialFiles };
}

async function renameAndMoveFile( _sourcePath, _sourceParsedPath, _destinationPath, context ) {
    const _sftp = new FTPClient();
    try {
        await _sftp.connect( _SFTPConfig );
        await _sftp.rename( _sourcePath, _sourceParsedPath );
        await _sftp.rename( _sourceParsedPath, _destinationPath );
    } catch (err) {
        context.log( err);
    } finally {
        context.log(`File spostato e/o rinominato da ${_sourcePath} a ${_destinationPath}`);
        await _sftp.end();
        return;
    }
}

async function sftpDownload( file, context ){
    const _sftp = new FTPClient();
    const _configurationJson = await readConfiguration(context);
    const _remoteFolderPath = _configurationJson.FUN_REMOTE_FOLDER;
    const _localFolderPath = tmpPath;
    try {
        await _sftp.connect( _SFTPConfig );
        const _remoteFilePath = `${_remoteFolderPath}/${file}`;
        const _localFilePath = `${_localFolderPath}/${file}`;
        try {
            context.log( `${tt()[0]} ${tt()[1]} --- start download ${_remoteFilePath}` );
            await _sftp.get( _remoteFilePath, _localFilePath );
            context.log(`File scaricato con successo: ${file}`);
        } catch ( downloadError ) {
            throw new Error(`Errore durante il download del file ${file}: ${downloadError.message}`);
        }
        await _sftp.end();
        context.log( `${tt()[0]} ${tt()[1]} --- end download` );
    } catch (err) {
        throw new Error(`Errore connessione sftp`);
    }
}

function dividereInBlocchi( obj, dimensioneMassima, _keySku, _keys, context ) {
    try {
        const numeroDiBlocchi = Math.ceil(obj[_keySku].length / dimensioneMassima);
        let blocchi = {};
        for (let i = 0; i < numeroDiBlocchi; i++) {
            let nomeBlocco = 'blocco' + (i + 1);
            blocchi[nomeBlocco] = {
                [_keySku]: []
            };
            _keys.forEach(chiave => {
                blocchi[nomeBlocco][chiave] = [];
            });
            for (let chiave in obj) {
                blocchi[nomeBlocco][chiave] = obj[chiave].slice(i * dimensioneMassima, (i + 1) * dimensioneMassima);
            }
        }
        return blocchi;  
    } catch (error) {
        throw new Error(`Generazione dei blocchi fallita`); 
    }
}

function createXlsxFromData( _obj, _language, _keySku, _data, context ) {
    try {
        const filePath = `${tmpPath}/${_data}_translation_${_language}.xlsx`;
        const ws_data = [];
        ws_data.push( _obj.colonne );
        _obj.data.forEach( datum => {
        Object.keys( datum ).forEach(blocco => {
            const items = datum[ blocco ];
            const length = items[ _keySku ].length;
            for (let i = 0; i < length; i++) {
            const row = [];
            _obj.colonne.forEach( col => {
                row.push( items[ col ][ i ] );
            });
            ws_data.push( row );
            }
        });
        });
        const ws = xlsx.utils.aoa_to_sheet( ws_data );
        const wb = xlsx.utils.book_new( );
        xlsx.utils.book_append_sheet( wb, ws, 'Foglio1' );
        xlsx.writeFile( wb, filePath );
        context.log( `${tt()[0]} ${tt()[1]}: == End Translation file == ${tmpPath}/${_data}_translation_${_language}.xlsx`);     
    } catch (error) {
       // fallisce la scrittura dell'excel 
    }
 
}

async function writeXlxs( _nomeColonne, _nomeFileTradotto, _bloccoTradotto, _datiEstratti, context ){
    const stringa = _nomeFileTradotto;
    const regex = /\/(\d{8})_\d{2}_blocchi_tradotti_(\w+)\.json$/;
    const match = stringa.match(regex); 
    const _dataFormattata = match[1];
    const _lingua = match[2];
    const _configurationJson = await readConfiguration( context );
    const _colonneDaEscludere = _configurationJson.FUN_EXCLUDE_COLUMN;
    try {
        const blocchi = _bloccoTradotto;
        let _mergedData = {
            colonne: _nomeColonne.concat(_colonneDaEscludere),
            data: [
            ]
        }; 
        for ( const key in blocchi ) {
            let _blocco = blocchi[key]['blocco'+key].replace(/\"/g, "'").slice(1,-1);
            const _prodotti = _blocco.split('{{row}}');
            const _result = {};
            _nomeColonne.forEach(key => {
                _result[key] = [];
            });
            var _indexProduct = -1;
            _prodotti.forEach(item => {
                _indexProduct++;
                const values = item.split('{{s}}').map(value => value.trim());
                _nomeColonne.forEach((key, index) => {
                    _result[key].push(values[index]);

                });
            });
            _colonneDaEscludere.forEach((key2, index2) => {
                _result[key2] = "";
            });
            _colonneDaEscludere.forEach((key, index) => {
                _result[key] = [];
                _datiEstratti.forEach(arr => {
                    _result[key].push(arr[index]);
                });
            });
            const block = {};
            block['blocco'+key] = _result;
            _mergedData.data.push(block);  
        }
        createXlsxFromData( _mergedData, _lingua, _configurationJson.FUN_SKU_COLUMN, _dataFormattata, context );   
    } catch (error) {
        // fallisce il parsing del blocco
        context.log( error );
    }
}

async function generaXlxs( _sorgente, _nameFileOriginal, _extensionFile, _files, _blocchiZTradotti, context ){
    let _localFiles = [];
    let _remotePaths = [];
    try {
        const _localFolderPath = `${tmpPath}/${_sorgente}`;
        const _configurationJson = await readConfiguration( context );
        const _workbook = xlsx.readFile( _localFolderPath );
        const _sheetName = _workbook.SheetNames[ 0 ];
        const _sheet = _workbook.Sheets[ _sheetName ];
        const _colonneDaEscludere = _configurationJson.FUN_EXCLUDE_COLUMN;
        const _data = xlsx.utils.sheet_to_json( _sheet, { header:1 } );

        const _indiciColonneselezionate = _colonneDaEscludere.map(colonna => _data[0].indexOf(colonna));
        const _datiEstratti = _data.map(riga => _indiciColonneselezionate.map(indice => riga[indice]));
        _datiEstratti.shift();

        const _nomeColonneDef = _data[0].filter( col => !_colonneDaEscludere.includes( col ) );
        for (let k = 0; k < _files.length; k++) {
            await writeXlxs( _nomeColonneDef, _files[k], _blocchiZTradotti[k], _datiEstratti, context ); 
        }
        // generazione dei file per upload
        for (let k = 0; k < _files.length; k++) {
            const stringa = _files[k];
            const regex = /\/(\d{8})_\d{2}_blocchi_tradotti_(\w+)\.json$/;
            const match = stringa.match(regex); 
            _localFiles.push( `${tmpPath}/${match[1]}_translation_${match[2]}.xlsx` );
            _remotePaths.push( `${match[1]}_${_nameFileOriginal}_translated_${match[2]}.xlsx` );
        }
        success.parsingFile = true;
    } catch (error) {
        throw new Error(`Parsing delle traduzioni falliti`); 
    }

    if( success.parsingFile ){
        try {
            await sftpCopyFileAll( _localFiles, _remotePaths, context );  
            success.uploadFile = true; 
        } catch (error) {  
            context.log( error ); 
        }    
    }

    if( success.uploadFile ){
        try {
            await deleteLocalFiles( _localFiles, context ); 
            success.removeLocalFile = true; 
        } catch (error) {
        }
    }
}

async function sftpCopyFileAll( _localFiles, _remotePaths, context ){
    const sftp = new FTPClient();
    const _configurationJson = await readConfiguration( context );
    const _remoteFolderPath = _configurationJson.FUN_REMOTE_FOLDER_ELABORATE + '/';
    try {
        await sftp.connect( _SFTPConfig );
        const _uploadPromises = _localFiles.map( ( _localFile, _index ) => 
            sftp.put( _localFile, _remoteFolderPath + _remotePaths[ _index ] )
        );
        await Promise.allSettled( _uploadPromises );
    } catch (error) {
        context.error('Errore durante l\'upload dei file:', err.message);
    } finally {
        await sftp.end();
    }
}

async function sftpCopyFile( _source, _target, context ){
    const sftp = new FTPClient();
    const _configurationJson = await readConfiguration( context );
    const _remoteFolderPath = _configurationJson.FUN_REMOTE_FOLDER_ELABORATE;
    try {
        await sftp.connect( _SFTPConfig );
        context.log( `${tt()[0]} ${tt()[1]}: --- start upload ${_target}`); 
        const _data = fs.createReadStream( _source );
        const _remote = `${_remoteFolderPath}/${_target}`;
        await sftp.put( _data, _remote);
        await sftp.end();
        context.log( `${tt()[0]} ${tt()[1]}: --- end upload`); 
        return true;
    } catch (error) {
        context.log( error );
        return false;
    }
}

async function deleteLocalFiles( _localFiles, context ) {
    const deletePromises = _localFiles.map(file => {
        return new Promise((resolve, reject) => {
            fs.unlink(file, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
    await Promise.all( deletePromises ).then(() => {
        context.log("Tutti i file locali sono stati eliminati");
    }).catch((error) => {
        context.log("Errore nell'eliminazione di alcuni file:", error);
    });
}

function convertiLingua( _stringa ) {
    for ( let i = 0; i < dictionaryLanguages.length; i++ ) {
      const _lingua = Object.keys( dictionaryLanguages[ i ] )[ 0 ];
      if ( _lingua === _stringa ) {
        return dictionaryLanguages[ i ][ _lingua ];
      }
    }
    return _stringa;
}


async function csvInteract( _pathFolderFile, context ){
    const _configurationJson = await readConfiguration( context );
    const risultati_colonne_non_escluse_CSV = {};
    const risultati_colonne_escluse_CSV = {};
    const colonneDaEscludere = _configurationJson.FUN_EXCLUDE_COLUMN;
    let nome_colonne_non_escluse_CSV = [];
    let nome_colonne_escluse_CSV = _configurationJson.FUN_EXCLUDE_COLUMN;
    let nome_colonne_CSV = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream( _pathFolderFile)
        .pipe( csv( { separator: _configurationJson.FUN_SEPARATOR_CHAR } ) )
        .on('headers', (headers) => {
            nome_colonne_CSV = headers;
    
            nome_colonne_non_escluse_CSV = headers.filter(col => !colonneDaEscludere.includes(col));
            nome_colonne_non_escluse_CSV.forEach(col => {
                risultati_colonne_non_escluse_CSV[col] = [];
            });
    
            nome_colonne_escluse_CSV.forEach(col => {
                risultati_colonne_escluse_CSV[col] = [];
            });
    
        })
        .on('data', (row) => {
            nome_colonne_non_escluse_CSV.forEach(col => {
                if (row[col] !== undefined) { 
                    risultati_colonne_non_escluse_CSV[col].push(row[col]);
                }
            });
            nome_colonne_escluse_CSV.forEach(col => {
                if (row[col] !== undefined) { 
                    risultati_colonne_escluse_CSV[col].push(row[col]);
                }
            }); 
        })
        .on('end', async () => {
            resolve({ 
                risultati: risultati_colonne_non_escluse_CSV, 
                nomeColonneDef: nome_colonne_non_escluse_CSV 
            });
        })
        .on('error', reject);
    });


}

async function buildPrompt( _dictionary ) {
    let empty = true;
    let prompt = "\n- Le seguenti keywords dovranno essere tradotte in questo modo:\n";
    for ( const parolaChiave in _dictionary ) {
        if (Object.hasOwnProperty.call(_dictionary, parolaChiave)) {
            const traduzione = _dictionary[parolaChiave];
            prompt += `da '${parolaChiave}' a '${traduzione}'\n`;
            empty = false;
        }
    }
    return empty ? '' : prompt;
}

app.http('HttpTranslationMiddleware', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async ( request, context ) => {
        const _dataCorrente = new Date();
        let _languagesTemp = [];
        let _languages = [];
        let _primaryLanguage = '';
        let _fileToTranslateWithoutEstension = '';
        const _fileToTranslate = ( request.query.get( 'fileToTranslate' ) || await request.text() || '');
        const _ENVIRONMENT = ( request.query.get( 'env' ) || await request.text() || '');
        if( _fileToTranslate ){
            const _match = _fileToTranslate.match(/\[(.*?)\]/);
            if ( _match ) {
                const _languagesPart = _match[1];
                _languagesTemp = _languagesPart.match(/[a-z]{2}/gi);
                _primaryLanguage = convertiLingua( _languagesTemp.shift() );
                _languages = _languagesTemp.map( _lingua => convertiLingua( _lingua ) );
            }  
            const _match_ENVIRONMENT = _fileToTranslate.match(/\{(.*?)\}/);
            if ( _match_ENVIRONMENT ) {
                ENVIRONMENT = _match_ENVIRONMENT[1];
                if( ENVIRONMENT != 'bata' && ENVIRONMENT != 'awlab' ){
                    ENVIRONMENT = 'bata';
                }
            }
            _fileToTranslateWithoutEstension = '_' + _fileToTranslate.substring(0, _fileToTranslate.lastIndexOf('.'));
        }
        if( _ENVIRONMENT === 'bata' || _ENVIRONMENT === 'awlab' ){
            ENVIRONMENT = _ENVIRONMENT;
        }
        
        _nameFileLog = `${_dataCorrente.toISOString().slice(0, 10).replace(/-/g, "")}_${('0' + _dataCorrente.getHours()).slice(-2)}${('0' + _dataCorrente.getMinutes()).slice(-2)}_elaborate${_fileToTranslateWithoutEstension}.log`;
        _nameFileLogNotificationDev = `${_dataCorrente.toISOString().slice(0, 10).replace(/-/g, "")}_${('0' + _dataCorrente.getHours()).slice(-2)}${('0' + _dataCorrente.getMinutes()).slice(-2)}_elaborate${_fileToTranslateWithoutEstension}_DEV.log`;
        
        const _deleteFileLog = await fs.unlink(_nameFileLog, (err) => {
            if (err) {
                context.log(err);
              return;
            }
        });

        writeLog(`${tt()[1]}: == Start Work`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: query.get env - ${ request.query.get( 'env' ) }`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: query.get fileToTranslate - ${ request.query.get( 'fileToTranslate' ) }`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: environment - ${ENVIRONMENT}`, _nameFileLogNotificationDev);
        
        writeLog(`${tt()[1]}: == Start Work`, _nameFileLog);
        writeLog(`${tt()[1]}: query.get env - ${ request.query.get( 'env' ) }`, _nameFileLog);
        writeLog(`${tt()[1]}: query.get fileToTranslate - ${ request.query.get( 'fileToTranslate' ) }`, _nameFileLog);
        writeLog(`${tt()[1]}: environment - ${ENVIRONMENT}`, _nameFileLog);

        const startTime = new Date();
        let dividedData_2 = [];
        const meta_prompt_2 = prompt.meta_prompt_2;
        writeLog(`${tt()[1]}: read configuration`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: read configuration`, _nameFileLog);
        const _configurationJson = await readConfiguration( context );
        const _colonneDaEscludere = _configurationJson.FUN_EXCLUDE_COLUMN;
        // const _colonneSkuDaEscludere = _configurationJson.FUN_SKU_COLUMN;
        const _numberItem = numberItemBlock;
        const _endpoint = process.env["AZURE_OPENAI_ENDPOINT_"+branch] ? process.env["AZURE_OPENAI_ENDPOINT_"+branch]  : env["AZURE_OPENAI_ENDPOINT_"+branch];
        const _azureApiKey = process.env["AZURE_OPENAI_API_KEY_"+branch] ? process.env["AZURE_OPENAI_API_KEY_"+branch] : env["AZURE_OPENAI_API_KEY_"+branch];
        let _files = {};
        if( !_fileToTranslate ){
            const _filesWithExtensions = await sftpInteract( context );
            _files = {
                remainingFiles: _filesWithExtensions.remainingFiles,
                partialFiles: _filesWithExtensions.partialFiles
            };
        }else{
            writeLog(`${tt()[1]}: start download`, _nameFileLogNotificationDev);
            try {
                // Tenta il download del file.
                await sftpDownload( _fileToTranslate, context );
                success.downloadFile = true;
                context.log("Download completato");
                writeLog(`${tt()[1]}: end download`, _nameFileLogNotificationDev);
            } catch (error) {
                // In caso di errore durante il download, logga l'errore.
                context.log(`Download fallito: ${error.message}`);
                writeLog(`${tt()[1]}: download error`, _nameFileLogNotificationDev);
            }
            const fileName = _fileToTranslate;
            const fileExtension = fileName.split('.').pop();
            const parsedPath = path2.parse( fileName );
            _files = {
                remainingFiles: [ { name: fileName, type: fileExtension, nameWithoutExtension: parsedPath.name } ],
                partialFiles: [ ]
            };    
        }
        let _lingue_da_tradurre =  _configurationJson.FUN_TRANSLATION_LANG;
        if( _languages.length > 0 ){
            _lingue_da_tradurre = _languages;
        }
        let _lingua_sorgente = _configurationJson.FUN_TRANSLATION_SOURCE_LANG;
        if( _primaryLanguage ){
            _lingua_sorgente = _primaryLanguage;
        }

        writeLog(`${tt()[1]}: primary language ${_lingua_sorgente}`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: languages to translations ${JSON.stringify(_lingue_da_tradurre)}`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: primary language ${_lingua_sorgente}`, _nameFileLog);
        writeLog(`${tt()[1]}: languages to translations ${JSON.stringify(_lingue_da_tradurre)}`, _nameFileLog);

        if( success.downloadFile ){
            writeLog(`${tt()[1]}: start translation`, _nameFileLogNotificationDev);
            for (let k = 0; k < _files.remainingFiles.length; k++) {
                writeLog(`${tt()[1]}: source file - ${JSON.stringify(_files.remainingFiles[k])}`, _nameFileLogNotificationDev);
                writeLog(`${tt()[1]}: type - ${_files.remainingFiles[k].type}`, _nameFileLogNotificationDev);
                try {
                    let _filesTradotti = [];
                    let _blocchiZTradotti = [];
                    let _filteredObj = [];
                    let _nomeColonneDef = [];
                    const _nameFile = _files.remainingFiles[k].name;
                    const _extensionFile = _files.remainingFiles[k].type;
                    const _nameFileOriginal = _files.remainingFiles[k].nameWithoutExtension;
                    const _indexFileString = String( k ).padStart( 2, '0' );
                    if( _files.remainingFiles[k].type.toLowerCase() === 'csv' ){
                        const _data = await csvInteract( `${tmpPath}/${_nameFile}`, context );
                        _filteredObj = _data.risultati;
                        _nomeColonneDef = _data.nomeColonneDef;
                    }else if( _files.remainingFiles[k].type.toLowerCase() === 'xlsx' ){
                        const _workbook = xlsx.readFile( `${tmpPath}/${_nameFile}` );
                        const _sheetName = _workbook.SheetNames[0];
                        const _sheet = _workbook.Sheets[ _sheetName ];
                        const _data = xlsx.utils.sheet_to_json( _sheet, { header: 1 } );
                        const _nomeColonne = _data[ 0 ];
                        _nomeColonneDef = _data[ 0 ].filter( col => !_colonneDaEscludere.includes(col));
                        const _risultati = _nomeColonne.reduce(( acc, col ) => ({...acc, [ col ]: []}), {});
                        let indexm = 0;
                        let slicedData = _data.slice(1);
                        for (let row of slicedData) {
                            indexm++;
                            if (indexm === 999) {
                                break;
                            }    
                            _nomeColonne.forEach((col, index) => {
                                let valore = row.length > index ? row[index] : "";
                                _risultati[col].push(valore);
                            });
                        }
                        _filteredObj = Object.keys(_risultati)
                        .filter(key => _nomeColonneDef.includes(key))
                        .reduce((acc, key) => {
                          acc[key] = _risultati[key];
                          return acc;
                        }, {});
                    }
                    const stringa_istruzioni_prompt = _nomeColonneDef.join(',');
                    writeLog(`${tt()[1]}: create block items`, _nameFileLogNotificationDev);
                    try {
                        dividedData_2 = dividereInBlocchi( _filteredObj, _numberItem, _configurationJson.FUN_SKU_COLUMN, _nomeColonneDef, context );
                        success.createBlock = true;
                        writeLog(`${tt()[1]}: create block items OK`, _nameFileLogNotificationDev);
                    } catch (error) {
                        context.log( error );
                        writeLog(`${tt()[1]}: create block items KO`, _nameFileLogNotificationDev);
                    }
                    if( success.createBlock  ){
                        writeLog(`${tt()[1]}: create strings product items`, _nameFileLogNotificationDev);
                        let blocchi_da_tradurre = [];
                        for (const key in dividedData_2) {
                            if (dividedData_2.hasOwnProperty(key)) {
                                let stringa_totale_concatenata = '';
                                const blocco = dividedData_2[key];
                                for (let i = 0; i < blocco[_nomeColonneDef[0]].length; i++) {
                                    for (let j = 0; j < _nomeColonneDef.length; j++) {
                                        stringa_totale_concatenata = stringa_totale_concatenata + (blocco[_nomeColonneDef[j]][i] !== undefined  ? blocco[_nomeColonneDef[j]][i] : '') + '{{s}}';
                                    }
                                    stringa_totale_concatenata = stringa_totale_concatenata.slice(0, stringa_totale_concatenata.lastIndexOf('{{s}}'));
                                    stringa_totale_concatenata = stringa_totale_concatenata.trim();
                                    stringa_totale_concatenata = stringa_totale_concatenata + '{{row}}';
                                }
                                // elimino ultimo tag {{row}}
                                stringa_totale_concatenata = stringa_totale_concatenata.slice(0, stringa_totale_concatenata.lastIndexOf('{{row}}'));
                                stringa_totale_concatenata = stringa_totale_concatenata.trim();
                                blocchi_da_tradurre.push(stringa_totale_concatenata);
                            }
                        }
                        writeLog(`${tt()[1]}: start translations`, _nameFileLogNotificationDev);
                        try {
                            for (let j = 0; j < _lingue_da_tradurre.length; j++) {
                                let blocchiZTradotti = [];
                                let meta_prompt_def = meta_prompt_2.replace("{{stringa_campi}}", stringa_istruzioni_prompt);
                                meta_prompt_def = meta_prompt_def.replace("{{stringa_campi}}", stringa_istruzioni_prompt);
                                meta_prompt_def = meta_prompt_def.replace("{{lingua-sorgente}}", _lingua_sorgente);
                                let prompt_definitivo = meta_prompt_def.replace("{{lingua-da-tradurre}}", _lingue_da_tradurre[j])
                                const _dictionary = await readDictionary( _lingue_da_tradurre[j] ); 
                                const _buildPrompt = await buildPrompt( _dictionary );

                                prompt_definitivo += _buildPrompt;
                    
             
                                writeLog(`${tt()[1]}: language to translation - ${_lingue_da_tradurre[j]}`, _nameFileLogNotificationDev);
                                

                                writeLog(`${tt()[1]}: start parse blocks`, _nameFileLogNotificationDev);

                                for (let g = 0; g < blocchi_da_tradurre.length; g++) {
                                    writeLog(`${tt()[1]}: index block ${g}`, _nameFileLogNotificationDev);
                                    const _indexBlockString = String( g ).padStart( 3, '0' );
                                    const _stringa_totale_concatenata = blocchi_da_tradurre[g];
                                    const _messages = [
                                        { role: "user", content: `${prompt_definitivo}. Le righe da tradurre sono: "${_stringa_totale_concatenata}"` },
                                    ];

                                    writeLog(`${tt()[1]}: message to openAi - ${JSON.stringify(_messages)}`, _nameFileLogNotificationDev);
                                  

                                    try {
                                        context.log( `${tt()[0]} ${tt()[1]}: == Start Translation to ${_lingue_da_tradurre[ j ]} block ${g} ==`); 
                                        const client = new OpenAIClient( _endpoint, new AzureKeyCredential( _azureApiKey ) );
                                        const deploymentId = MODELNAME;
                                        const result = await client.getChatCompletions(deploymentId, _messages);
                                        let translations = '';
                                        for (const choice of result.choices) {
                                            translations = choice.message.content;
                                        }
                                        let content = translations;
                                        try {
                                            content = translations.replace(/\n\n/g, '');
                                            content = content.replace(/\n/g, '');   
                                        } catch (error) {
                                            
                                        }
  
                                        // const _result = {
                                        //     id: result.id,
                                        //     model: result.model,
                                        //     object: result.object,
                                        //     usage: result.usage,
                                        //     systemFingerprint: result.systemFingerprint,
                                        //     created: result.created,
                                        //     promptFilterResults: result.promptFilterResults,
                                        // };
                                        // const _mergedData = {
                                        //     prompt: meta_prompt_def,
                                        //     result: _result,
                                        //     colonne: _nomeColonneDef,
                                        //     stringa_totale_concatenata: _stringa_totale_concatenata,
                                        // };
                                        // const _jsonString = JSON.stringify( _mergedData, null, 2 );
                                        // const _destFile = `${tmpPath}/${tt()[0]}_${_indexFileString}_${_indexBlockString}_output_${_lingue_da_tradurre[ j ]}.json`;
                                        // fs.writeFile( _destFile , _jsonString, (err) => {
                                        //     if (err) {
                                        //         context.log('Errore durante la scrittura del file:', err);
                                        //         return;
                                        //     }
                                        // });
                                        const block = {};
                                        block[ 'blocco' + g ] = content;
                                        blocchiZTradotti.push(block); 
                                        success.openaiTranslations = true; 
                                        writeLog(`${tt()[1]}: success translation block - ${content}`, _nameFileLogNotificationDev);
                                    } catch (error) {
                                        success.openaiTranslations = false; 
                                        context.log( error );
                                        writeLog(`${tt()[1]}: error translation block - ${JSON.stringify(error)}`, _nameFileLogNotificationDev);
                                    }
                                    if( g === 100 || !success.openaiTranslations){ break; }
                                }
                                context.log( `${tt()[0]} ${tt()[1]}: == End Translation to ${_lingue_da_tradurre[ j ]} ==`);  
                                const _destFile = `${tmpPath}/${tt()[0]}_${_indexFileString}_blocchi_tradotti_${_lingue_da_tradurre[ j ]}.json`;
                                _filesTradotti.push( _destFile );
                                _blocchiZTradotti.push( blocchiZTradotti );
                                writeLog(`${tt()[1]}: End Translation to ${_lingue_da_tradurre[ j ]}`, _nameFileLogNotificationDev);
                            }  
                                
                        } catch (error) {
                            context.log( error );
                            // fallisce il servizio openai
                            writeLog(`${tt()[1]}: ERROR CRITICAL ${JSON.stringify(error)}`, _nameFileLogNotificationDev);
                        }
                        if( success.openaiTranslations && _blocchiZTradotti.length > 0 ){
                            writeLog(`${tt()[1]}: start generation xlxs file`, _nameFileLogNotificationDev);
                            try {
                                await generaXlxs( _nameFile, _nameFileOriginal, _extensionFile, _filesTradotti, _blocchiZTradotti, context );
                                if( success.parsingFile ){
                                    writeLog(`${tt()[1]}: generation files success`, _nameFileLogNotificationDev);
                                    writeLog(`${tt()[1]}: start rename and move file`, _nameFileLogNotificationDev);
                                    try {
                                        const _startFolderPath = `${_configurationJson.FUN_REMOTE_FOLDER}/${_nameFile}`;
                                        const _startParsedFolderPath = `${_configurationJson.FUN_REMOTE_FOLDER}/${_nameFileOriginal}_parsed.${_files.remainingFiles[k].type}`;
                                        const _remoteFolderParsedPath = `${_configurationJson.FUN_REMOTE_FOLDER_PARSED}/${_nameFileOriginal}_parsed.${_files.remainingFiles[k].type}`;
    
                                        await renameAndMoveFile( _startFolderPath, _startParsedFolderPath, _remoteFolderParsedPath, context );      
                                        success.renameRemoteFile = true; 
                                        writeLog(`${tt()[1]}: rename and move files OK`, _nameFileLogNotificationDev);
                                    } catch (error) {
                                        context.log( error );
                                        writeLog(`${tt()[1]}: rename and move files errors - ${JSON.stringify(error)}`, _nameFileLogNotificationDev);
                                    }
                                }
                            } catch (error) {
                                // In caso di errore durante il download, logga l'errore.
                                context.log( error );
                                writeLog(`${tt()[1]}: generation files errors - ${JSON.stringify(error)}`, _nameFileLogNotificationDev);
                            }
                        }
                    }
                } catch (error) {
                   // fallisce a prescindere l'item del loop
                   context.log( error );
                   writeLog(`${tt()[1]}: translation errors - ${JSON.stringify(error)}`, _nameFileLogNotificationDev);
                }
            }
        }

        const _endTime = new Date();
        const _tempoTrascorso = _endTime - startTime; 
        const _minuti = Math.floor(_tempoTrascorso / 60000);
        const _secondi = ((_tempoTrascorso % 60000) / 1000).toFixed(0);
        const _benchMark = _minuti + ":" + (_secondi < 10 ? '0' : '') + _secondi + " minuti";
        const _success = {
            downloadFile: success.downloadFile ? 'executed' : 'not-executed',
            createBlock: success.createBlock ? 'executed' : 'not-executed',
            openaiTranslations: success.openaiTranslations ? 'executed' : 'not-executed',
            parsingFile: success.parsingFile ? 'executed' : 'not-executed',
            uploadFile: success.uploadFile ? 'executed' : 'not-executed',
            removeLocalFile: success.removeLocalFile ? 'executed' : 'not-executed',  
            renameRemoteFile: success.renameRemoteFile ? 'executed' : 'not-executed',
        };
        const _output = {
            "benchMark": _benchMark,
            "ENVIRONMENT":ENVIRONMENT,
            "BRANCH":branch,
            "files": _files,
            "success": _success,
        };
        const jsonFormattato = JSON.stringify( _output, null, 4 );
        
        writeLog(`${tt()[1]}: opinions - ${jsonFormattato}`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: == End Work`, _nameFileLogNotificationDev);
        writeLog(`${tt()[1]}: opinions - ${jsonFormattato}`, _nameFileLog);
        writeLog(`${tt()[1]}: == End Work`, _nameFileLog);
        
        const _stringaLanguages = _lingue_da_tradurre.join(', ');
        const _notificationEmailSubject= `[Automatic Translations Service] Traduzione da ${_lingua_sorgente} a ${_stringaLanguages} - notifica`;
        const _notificationEmailBody = `Gentile [utente] la traduzione del file ${_fileToTranslate} è stata completata in ${_benchMark}.`;
        
        const _recipients = ( process.env[ "_SMTP_RECIPIENT_" + ENVIRONMENT ] ? process.env[ "_SMTP_RECIPIENT_" + ENVIRONMENT ] : env[ "_SMTP_RECIPIENT_" + ENVIRONMENT ] ).split(',');
        for ( let m = 0; m < _recipients.length; m++) {
            const _recipient = _recipients[m];
            await sendEmail( _recipient === 'emanuele.saini@acconsulting.digital' ? _nameFileLogNotificationDev : false, _recipient, _notificationEmailSubject, _notificationEmailBody, context );
        }
        return { 
            body: jsonFormattato,
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        };
    }
});

async function writeLog( _message, _file) {
    try {
        fs.appendFileSync( `${tmpPath}/${_file}`, `${_message}\n`);
    } catch (error) {
    }
}
async function sendEmail( _file, _to, _subject, _body, context) {
    const _senderName = process.env[ "_SMTP_SENDER_NAME_" + ENVIRONMENT ] ? process.env[ "_SMTP_SENDER_NAME_" + ENVIRONMENT ] : env[ "_SMTP_SENDER_NAME_" + ENVIRONMENT ];
    const _senderEmail = process.env[ "_SMTP_SENDER_EMAIL_" + ENVIRONMENT ] ? process.env[ "_SMTP_SENDER_EMAIL_" + ENVIRONMENT ] : env[ "_SMTP_SENDER_EMAIL_" + ENVIRONMENT ];

    const _transporter = nodemailer.createTransport({
        host: process.env[ "SMTP_HOST_"+branch ] ? process.env[ "SMTP_HOST_"+branch ] : env[ "SMTP_HOST_"+branch ],
        port: parseInt( process.env[ "SMTP_PORT_"+branch ] ? process.env[ "SMTP_PORT_"+branch ] : env[ "SMTP_PORT_"+branch ] ),
        secure: parseInt(process.env[ "SMTP_SECURE_"+branch ] ? process.env[ "SMTP_SECURE_"+branch ] : env[ "SMTP_SECURE_"+branch ]) === 1 ? true : false,
        auth: {
            user: process.env[ "SMTP_USER_"+branch ] ? process.env[ "SMTP_USER_"+branch ] : env[ "SMTP_USER_"+branch ],
            pass: process.env[ "SMTP_PASSWORD_"+branch ] ? process.env[ "SMTP_PASSWORD_"+branch ] : env[ "SMTP_PASSWORD_"+branch ],
        },
    });
    try {
        let _options = {
            from: `"${_senderName}" <${_senderEmail}>`,
            to: _to,
            subject: _subject,
            text: _body,
            html: _body,
        };
        if( _file ){
          _options['attachments'] = [
                {   
                    filename: `${_file}`,
                    content: fs.createReadStream( `${tmpPath}/${_file}`)
                },
            ];
        }
        const info = await _transporter.sendMail(_options);
        context.log("Message sent: %s", info.messageId);
    } catch (error) {
        context.log('Errore:', error);
    }
}