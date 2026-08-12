import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { UserRegisterDto } from './dto/user-register.dto';
import User from '../users/entity/user.entity';
import { JwtService } from '@nestjs/jwt';
import { JwtPayloadProps } from './types';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly logger: Logger,
    private readonly jwtService: JwtService,
  ) {}

  private saltOrRounds = 10;

  async register(userRegisterDto: UserRegisterDto) {
    const { email, password } = userRegisterDto;
    console.log('🚀 ~ AuthService ~ register ~ email:', email);
    // Check if this email already exist
    const isEmailExist = await this.usersService.findUserByEmail(email);
    if (isEmailExist) {
      this.logger.error(`User try to use duplicated email ${email}`);
      throw new BadRequestException('This email already exist.');
    }

    const hashedPassword = await bcrypt.hash(password, this.saltOrRounds);

    const newUser = { ...userRegisterDto, password: hashedPassword };

    await this.usersService.createNewUser(newUser);

    this.logger.log(`New user with email ${email} had registered successfuly`);

    return { message: 'User created successfuly.', data: newUser };
  }

  async userValidation(
    email: string,
    password: string,
  ): Promise<null | Partial<User>> {
    // check if email exist first
    // check if this user with this email has the same password hash or not

    const isUserExist = await this.usersService.findUserByEmail(email);
    const isSamePasswordHash = await bcrypt.compare(
      password,
      isUserExist?.password || '',
    );

    if (isUserExist && isSamePasswordHash) {
      const { password, ...filteredUser } = isUserExist;
      return filteredUser;
    }

    return null;
  }

  //Generate the jwt for user after validation his credentionals
  async login(user: Partial<User>) {
    const { id, email, firstName, lastName, role } = user;
    const fullName = firstName + ' ' + lastName;
    const payload: JwtPayloadProps = { sub: id, email, fullName, role };

    const accessToken = await this.jwtService.signAsync(payload);

    this.logger.log(`User with email ${email} logged in successfuly.`);

    return { message: 'User loged in successfuly', accessToken };
  }
}
