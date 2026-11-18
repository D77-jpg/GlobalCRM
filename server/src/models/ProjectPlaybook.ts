import './tenant-setup';
import {Schema,model,Types,type HydratedDocument,type Model} from 'mongoose';
import type {PlaybookCardData} from '../services/agent/genesis-playbook.data';
import type { ProjectBrandProfile } from './Project';

export interface BrandPackageRevision {
  release: string;
  digest: string;
  profile: ProjectBrandProfile;
  segments: PlaybookCardData[];
  preferences: PlaybookCardData[];
}

export interface IProjectPlaybook{
  projectId:Types.ObjectId;
  version:number;
  segments:PlaybookCardData[];
  preferences:PlaybookCardData[];
  updatedBy?:Types.ObjectId;
  activePackage?: BrandPackageRevision;
  previousPackage?: BrandPackageRevision;
  createdAt:Date;
  updatedAt:Date;
}

export type ProjectPlaybookDocument=HydratedDocument<IProjectPlaybook>;
export type ProjectPlaybookModel=Model<IProjectPlaybook>;

const schema=new Schema<IProjectPlaybook>({
  projectId:{type:Schema.Types.ObjectId,required:true},
  version:{type:Number,required:true,default:1},
  segments:{type:Schema.Types.Mixed,default:[]},
  preferences:{type:Schema.Types.Mixed,default:[]},
  updatedBy:{type:Schema.Types.ObjectId,ref:'User'},
  activePackage: { type: Schema.Types.Mixed, select: false },
  previousPackage: { type: Schema.Types.Mixed, select: false },
},{timestamps:true,versionKey:false});

schema.index({projectId:1},{unique:true});

export const ProjectPlaybook=model<IProjectPlaybook,ProjectPlaybookModel>('ProjectPlaybook',schema);
export default ProjectPlaybook;
