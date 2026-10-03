'use strict';
const D=require('./domain');
const defaults=Object.freeze({dailyGoal:5,showGoal:true,slaDays:7,lawyerFollowupDays:7,hallSlots:4});
function read(row){return {...defaults,...Object.fromEntries(Object.keys(defaults).filter(k=>row?.[k]!==undefined).map(k=>[k,row[k]]))};}
function integer(value,min,max,label){const n=Number(value);D.assert(Number.isInteger(n)&&n>=min&&n<=max,'Bitte '+label+' zwischen '+min+' und '+max+' eingeben.');return n;}
function validate(input){
 D.assert(input&&typeof input==='object','Ungültige Einstellungen.');
 D.assert(typeof input.showGoal==='boolean','Bitte die Zielanzeige auswählen.');
 return {id:'zentrale-config',dailyGoal:integer(input.dailyGoal,1,30,'das Tagesziel'),showGoal:input.showGoal,slaDays:integer(input.slaDays,1,30,'die Zielzeit'),lawyerFollowupDays:integer(input.lawyerFollowupDays,1,30,'die Kanzlei-Nachfragefrist'),hallSlots:integer(input.hallSlots,1,12,'die Hallenplätze')};
}
module.exports={defaults,read,validate};
