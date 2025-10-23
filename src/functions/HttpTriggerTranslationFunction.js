const { app } = require('@azure/functions');

const FTPClient = require('ssh2-sftp-client'); 
const nodemailer = require("nodemailer");
const path2 = require('path');
const prompt = require( __dirname + '/res/configuration_prompt');
const env = require( __dirname + '/res/.env-local');
const fs = require('fs');
const axios = require('axios');
// branch di PRODUZIONE
let branch = process.env["_BRANCH"] ? process.env["_BRANCH"] : env["_BRANCH"];
let cron_function = process.env["_CRON_FUNCTION"] ? process.env["_CRON_FUNCTION"] : env["_CRON_FUNCTION"];

const numberItemBlock = process.env["NUMBER_ITEM_BLOCK_"+branch] ? process.env["NUMBER_ITEM_BLOCK_"+branch] : env["NUMBER_ITEM_BLOCK_"+branch];
const MODELNAME = process.env["MODEL_"+branch] ? process.env["MODEL_"+branch] : env["MODEL_"+branch];
const ENVIRONMENT = process.env["ENVIRONMENT_"+branch] ? process.env["ENVIRONMENT_"+branch] : env["ENVIRONMENT_"+branch];

const _SFTPConfig = {
    host: process.env[ "AWS_SFTP_HOST_"+branch ] ? process.env[ "AWS_SFTP_HOST_"+branch ] : env[ "AWS_SFTP_HOST_"+branch ],
    port: process.env[ "AWS_SFTP_PORT_"+branch ] ? process.env[ "AWS_SFTP_PORT_"+branch ]  : env[ "AWS_SFTP_PORT_"+branch ],
    username: process.env[ "AWS_SFTP_USER_"+branch ] ? process.env[ "AWS_SFTP_USER_"+branch ] : env[ "AWS_SFTP_USER_"+branch ],
    password: process.env[ "AWS_SFTP_PASSWORD_"+branch ] ? process.env[ "AWS_SFTP_PASSWORD_"+branch]  : env[ "AWS_SFTP_PASSWORD_"+branch],
    readyTimeout: 30000,
};

async function readConfiguration( _ENVIRONMENT, context ) {
    const _percorsoFile = path2.join( __dirname, 'res', `configuration_${_ENVIRONMENT}_${branch}.json` );
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
    const _configurationJson_bata = await readConfiguration('bata',context);
    const _remoteFolderPathBata = _configurationJson_bata.FUN_REMOTE_FOLDER;
    const _configurationJson_awlab = await readConfiguration('awlab',context);
    const _remoteFolderPathAwlab = _configurationJson_awlab.FUN_REMOTE_FOLDER;

    const sftp = new FTPClient();
    const _partialFiles = [];
    const _fullFiles = [];
    const _remainingFiles = [];
    try {
        await sftp.connect( _SFTPConfig );
        const _files_bata = await sftp.list( _remoteFolderPathBata );
        const _filesWithExtensionsBata = _files_bata.map( file => {
            const fileName = file.name;
            const fileExtension = fileName.split('.').pop();
            const parsedPath = path2.parse( fileName );
            return { name: fileName, type: fileExtension, nameWithoutExtension: parsedPath.name, ENVIRONMENT: 'bata' };
        });
        _filesWithExtensionsBata.forEach( _file => {
            const _fileNameWithoutExtension = _file.name.split( '.' )[ 0 ];
            if ( _fileNameWithoutExtension.endsWith( '_parsed' ) ) {
                _fullFiles.push(_file);
            } else if ( _fileNameWithoutExtension.endsWith( '_partial' ) ) {
                _partialFiles.push( _file );
            } else {
                _remainingFiles.push( _file );
            }
        });

        const _files_awlab = await sftp.list( _remoteFolderPathAwlab );
        const _filesWithExtensionsAwlab = _files_awlab.map( file => {
            const fileName = file.name;
            const fileExtension = fileName.split('.').pop();
            const parsedPath = path2.parse( fileName );
            return { name: fileName, type: fileExtension, nameWithoutExtension: parsedPath.name, ENVIRONMENT: 'awlab'  };
        });
        _filesWithExtensionsAwlab.forEach( _file => {
            const _fileNameWithoutExtension = _file.name.split( '.' )[ 0 ];
            if ( _fileNameWithoutExtension.endsWith( '_parsed' ) ) {
                _fullFiles.push(_file);
            } else if ( _fileNameWithoutExtension.endsWith( '_partial' ) ) {
                _partialFiles.push( _file );
            } else {
                _remainingFiles.push( _file );
            }
        });

        await sftp.end();
    } catch (err) {
        context.log('Errore durante l\'operazione di SFTP:', err);
    }

    return { remainingFiles: _remainingFiles, partialFiles: _partialFiles };
}

app.timer('HttpTriggerTranslationFunction', {
    schedule: cron_function, // '0 */5 * * * *',
    handler: async ( myTimer, context) => {
        context.log( branch );
        const _filesWithExtensions = await sftpInteract( context );
        let res = {};
        let urls = [];
        for (let k = 0; k < _filesWithExtensions.remainingFiles.length; k++) {
            const _file = _filesWithExtensions.remainingFiles[k].name;
            const _ENVIRONMENT = _filesWithExtensions.remainingFiles[k].ENVIRONMENT;
            // const _url = `https://apptranslationsproduction.azurewebsites.net/api/httptranslationmiddleware?fileToTranslate=${_file}&env=${_ENVIRONMENT}`;
            const _baseUrl = process.env["APP_TRANSLATIONS_BASE_URL_"+branch];
            const _url = `${_baseUrl}/httptranslationmiddleware?fileToTranslate=${_file}&env=${_ENVIRONMENT}`;
            if ( _file.includes( "parsed" ) ) {
            }else{
                urls.push( _url );
            }
        }
        context.log( urls );
        try {
            const promises = urls.map(url => axios.get(url));
            const responses = await Promise.all(promises);
            responses.forEach(response => {
                context.log(response.data);
            });
            res = {
                status: 200,
                body: "Richieste GET completate."
            };
        } catch (error) {
            context.log(error);
            res = {
                status: 500,
                body: "Si è verificato un errore durante l'elaborazione delle richieste GET."
            };
        }

        context.log(res);
    }
});
